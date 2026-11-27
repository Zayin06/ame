import type { Result } from "@opencode/schema/tool"

export const DEFAULT_TOOL_LIMITS = {
  grep: 48_000,
  glob: 32_000,
  read: 64_000,
} as const

export const DEFAULT_TURN_OUTPUT_LIMIT = 140_000
export const DEFAULT_MIN_FLOOR_CHARS = 4_000
const MAX_TRACKED_TURNS = 512

type GuardedTool = keyof typeof DEFAULT_TOOL_LIMITS

export type ToolAfterExecuteInput = {
  readonly tool: string
  readonly sessionID: string
  readonly messageID: string
  readonly status: "completed" | "error"
  result?: Result
}

export type ToolOutputGuardOptions = {
  toolLimits?: Partial<Record<GuardedTool, number>>
  maxTurnChars?: number
  minFloorChars?: number
}

const TOOL_HINTS: Record<GuardedTool, string> = {
  grep: "Thu hẹp path, include, pattern hoặc đặt limit <= 200 (tránh quét toàn bộ thư mục đa ngôn ngữ như res/).",
  glob: "Thu hẹp pattern glob hoặc phạm vi thư mục cụ thể hơn.",
  read: "Dùng tham số offset và limit để đọc từng đoạn theo dòng.",
}

function safeSlice(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  let end = maxChars
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  const minBreak = Math.floor(end * 0.9)
  const nl = text.lastIndexOf("\n", end - 1)
  if (nl >= minBreak) end = nl
  return text.slice(0, end)
}

function countContentChars(result: Result): number {
  let total = 0
  if (typeof result.content === "string") total += result.content.length
  else if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part && part.type === "text" && typeof part.text === "string") total += part.text.length
    }
  }
  return total
}

function countOutputChars(result: Result): number {
  return typeof result.output === "string" ? result.output.length : 0
}

function truncateContentField(content: Result["content"], budget: number, notice: string): { content: Result["content"]; keptChars: number } {
  let remaining = budget
  let keptChars = 0
  let noticeAttached = false

  const applySlice = (value: string): string => {
    if (remaining <= 0) return ""
    const sliced = safeSlice(value, remaining)
    keptChars += sliced.length
    remaining -= sliced.length
    if (!noticeAttached && remaining === 0) {
      noticeAttached = true
      return sliced + notice
    }
    return sliced
  }

  let nextContent = content
  if (typeof content === "string") {
    nextContent = applySlice(content)
    if (!noticeAttached && typeof nextContent === "string") nextContent += notice
  } else if (Array.isArray(content)) {
    const updated = []
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        const text = applySlice(part.text)
        if (text || updated.length === 0) updated.push({ ...part, text })
      } else {
        updated.push(part)
      }
    }
    if (!noticeAttached) {
      const lastText = [...updated].reverse().find(item => item.type === "text")
      if (lastText && lastText.type === "text") {
        lastText.text += notice
        noticeAttached = true
      }
    }
    nextContent = updated
  }
  return { content: nextContent, keptChars }
}

/** Bounds massive grep/glob/read tool outputs once before they enter history; turnKey tracks the per-assistant-step budget for parallel tool calls. */
export function createToolOutputGuard(options: ToolOutputGuardOptions = {}) {
  const toolLimits: Record<GuardedTool, number> = { ...DEFAULT_TOOL_LIMITS, ...options.toolLimits }
  const maxTurnChars = options.maxTurnChars ?? DEFAULT_TURN_OUTPUT_LIMIT
  const minFloorChars = options.minFloorChars ?? DEFAULT_MIN_FLOOR_CHARS
  const turnUsage = new Map<string, number>()

  function recordTurnChars(turnKey: string, nextUsed: number) {
    if (turnUsage.has(turnKey)) turnUsage.delete(turnKey)
    turnUsage.set(turnKey, nextUsed)
    while (turnUsage.size > MAX_TRACKED_TURNS) {
      const oldest = turnUsage.keys().next().value
      if (oldest === undefined) break
      turnUsage.delete(oldest)
    }
  }

  function truncateAfterExecute(input: ToolAfterExecuteInput): void {
    if (input.status !== "completed" || !input.result) return
    const tool = input.tool.trim().toLowerCase()
    if (tool !== "grep" && tool !== "glob" && tool !== "read") return
    const result = input.result
    const contentChars = countContentChars(result)
    const outputChars = countOutputChars(result)
    const originalChars = Math.max(contentChars, outputChars)
    if (originalChars <= 0) return

    const turnKey = `${input.sessionID}:${input.messageID}`
    const used = turnUsage.get(turnKey) ?? 0
    const remainingTurnBudget = Math.max(0, maxTurnChars - used)
    const perToolMax = toolLimits[tool]
    const turnCap = Math.max(minFloorChars, remainingTurnBudget)
    const budget = Math.min(perToolMax, turnCap)

    if (originalChars <= budget) {
      recordTurnChars(turnKey, used + originalChars)
      return
    }

    const reason: "per-tool" | "per-turn" = perToolMax <= turnCap ? "per-tool" : "per-turn"
    const notice = `\n\n[amekit-output-guard: Đã cắt bớt output ${tool} (${budget}/${originalChars} ký tự, lý do: ${reason === "per-tool" ? "vượt trần 1 lệnh" : "vượt ngân sách lượt"}). Gợi ý: ${TOOL_HINTS[tool]}]`

    let keptContentChars = contentChars
    let nextContent = result.content
    if (contentChars > budget) {
      const truncated = truncateContentField(result.content, budget, notice)
      nextContent = truncated.content
      keptContentChars = truncated.keptChars
    }

    let keptOutputChars = outputChars
    let nextOutput = result.output
    if (typeof result.output === "string" && outputChars > budget) {
      const sliced = safeSlice(result.output, budget)
      keptOutputChars = sliced.length
      nextOutput = sliced + notice
    }

    const keptChars = Math.max(keptContentChars, keptOutputChars)
    recordTurnChars(turnKey, used + keptChars)
    input.result = {
      ...result,
      ...(nextContent !== undefined ? { content: nextContent } : {}),
      ...(nextOutput !== undefined ? { output: nextOutput } : {}),
      metadata: {
        ...result.metadata,
        amekitTruncated: true,
        originalChars,
        keptChars,
        truncationReason: reason,
      },
    }
  }

  return { truncateAfterExecute }
}
