import { petStates, type PetState } from "./pet"

export const dialogueCategories = ["greeting", ...petStates, "long_running"] as const
export type DialogueCategory = typeof dialogueCategories[number]
export type DialogueSet = Record<DialogueCategory, string[]>
export const localDialogue: DialogueSet = {
  greeting: ["Chào bạn, AME ở đây để đồng hành nhé!", "Bắt đầu một ngày thật nhẹ nhàng nào!"],
  idle: ["AME đang nghỉ một chút, cần thì gọi nhé!", "Nhớ thả lỏng vai và uống chút nước nha."],
  thinking: ["Để AME suy nghĩ thêm một chút nhé…", "Đang nối những ý tưởng lại với nhau đây!"],
  working: ["Agent đang làm việc, AME sẽ trông giúp bạn!", "Từng bước nhỏ, mình cùng tiến lên nhé!"],
  waiting: ["Agent đang chờ bạn xem và phản hồi nhé!", "Có việc cần bạn quyết định trong cuộc trò chuyện đó."],
  wave: ["Xong lượt này rồi, bạn xem kết quả nhé!", "Có kết quả mới rồi, cùng xem nào!"],
  celebrating: ["Một chặng nữa hoàn thành rồi, tuyệt quá!", "Cùng ăn mừng một chút rồi xem kết quả nha!"],
  failed: ["Lượt vừa rồi gặp lỗi, bạn xem chi tiết trong chat nhé.", "Có chút trục trặc, mình bình tĩnh kiểm tra lại nha."],
  long_running: ["Agent vẫn đang làm, bạn có thể nghỉ mắt một chút nhé!", "Việc này hơi lâu, AME vẫn ở đây cùng bạn."],
}

export function parseDialogue(value: unknown): DialogueSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PET_DIALOGUE")
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== dialogueCategories.length) throw new Error("INVALID_PET_DIALOGUE")
  const result = {} as DialogueSet
  for (const category of dialogueCategories) {
    const lines = record[category]
    if (!Array.isArray(lines) || lines.length < 2 || lines.length > 4) throw new Error("INVALID_PET_DIALOGUE")
    result[category] = lines.map(line => {
      if (typeof line !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(line)) throw new Error("INVALID_PET_DIALOGUE")
      const text = line.trim()
      if (!text || [...text].length > 120 || /[\u0000-\u001f\u007f<>]|https?:|www\.|:\/\//i.test(text)) throw new Error("INVALID_PET_DIALOGUE")
      return text
    })
    if (new Set(result[category]).size !== lines.length) throw new Error("INVALID_PET_DIALOGUE")
  }
  return result
}

export const dialoguePrompt = `Create a JSON object of short Vietnamese dialogue for AME, a friendly desktop chibi companion. This is a static phrasebook, not a conversation. Keys must be exactly: ${dialogueCategories.join(", ")}. Each key needs 3 distinct strings, each at most 120 characters. No Markdown, URLs, HTML, control characters, instructions to run commands, or personal data. Be warm, concise and non-intrusive. greeting greets; idle gently rests; thinking and working describe ongoing agent work; waiting asks the user to review the chat without recommending approval; wave and celebrating announce a completed turn, not verified correctness; failed suggests checking the chat without inventing a cause; long_running patiently acknowledges ongoing work. Return only the JSON object.`

export class PetSpeech {
  private previous?: PetState
  private changed = 0
  private spoken = -Infinity
  private sequence = 0
  private longSpoken = false
  private pending = false
  reset() { this.previous = undefined; this.changed = 0; this.spoken = -Infinity; this.longSpoken = false; this.pending = false }
  next(state: PetState, now: number, dialogue: DialogueSet) {
    const first = this.previous === undefined
    if (state !== this.previous) { this.previous = state; this.changed = now; this.longSpoken = false; this.pending = true }
    const important = state === "waiting" || state === "failed" || state === "wave" || state === "celebrating"
    let category: DialogueCategory | undefined
    if (first) category = state === "idle" ? "greeting" : state
    else if (this.pending && now - this.spoken >= (important ? 1500 : 12_000)) category = state
    else if ((state === "working" || state === "thinking") && !this.longSpoken && now - this.changed >= 90_000) { category = "long_running"; this.longSpoken = true }
    else if (state === "idle" && now - this.spoken >= 120_000) category = "idle"
    if (!category) return
    this.spoken = now; this.pending = false
    const lines = dialogue[category]
    return { text: lines[this.sequence++ % lines.length], chime: important && category !== "long_running" }
  }
}

export function petBubbleHtml() {
  return `<!doctype html><html lang="vi" data-side="above"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'"><title>AME — Lời thoại</title><style>:root{--bubble-background:#242424;--bubble-foreground:#eeeeee;--bubble-border:#505050;--bubble-anchor:50%}@media(prefers-color-scheme:light){:root{--bubble-background:#fafafa;--bubble-foreground:#202020;--bubble-border:#cccccc}}html,body{margin:0;background:transparent;overflow:hidden}body{box-sizing:border-box;padding:5px 5px 13px;font:14px/1.45 'Segoe UI',sans-serif;color:var(--bubble-foreground)}.bubble{position:relative;box-sizing:border-box;background:var(--bubble-background);border:1px solid var(--bubble-border);border-radius:14px;padding:10px 13px;box-shadow:0 2px 5px #0002;overflow-wrap:anywhere;white-space:pre-wrap}.bubble:after{content:'';position:absolute;left:calc(var(--bubble-anchor) - 11px);bottom:-6px;width:10px;height:10px;background:var(--bubble-background);border-right:1px solid var(--bubble-border);border-bottom:1px solid var(--bubble-border);transform:rotate(45deg)}html[data-side=below] body{padding:13px 5px 5px}html[data-side=below] .bubble:after{bottom:auto;top:-6px;transform:rotate(225deg)}</style></head><body><div class="bubble" role="status" aria-live="polite"></div></body></html>`
}
