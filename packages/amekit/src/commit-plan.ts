export const COMMIT_SNAPSHOT_PREFIX = "[Commit snapshot: "
export const COMMIT_PLAN_MAX_GROUPS = 30
export const COMMIT_PLAN_MAX_FILES_PER_GROUP = 200
export const COMMIT_PLAN_MAX_MESSAGE_LENGTH = 10000
export type CommitAgentPlanViolation = { groupIndex: number; subject: string; fileCount: number; maxFiles: number }
export type CommitAgentPlanInspection = {
  plan: { scope?: "staged" | "working"; commits: { message: string; files: string[] }[] }
  violations: CommitAgentPlanViolation[]
}

function parseLeadingSnapshotHeader(section: string): string | null {
  for (const line of section.split("\n")) {
    if (line.startsWith(COMMIT_SNAPSHOT_PREFIX)) {
      return /^\[Commit snapshot: ([A-Za-z0-9_-]+)\]$/.exec(line)?.[1] ?? null
    }
    if (!/^\[(?:Commit mode: (?:analyze|split|single|custom)|Translation mode: (?:update|full|scan|custom))\]$/.test(line)) break
  }
  return null
}

/** Read snapshot metadata only from the request's leading header lines, not its body. */
export function extractCommitSnapshotID(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n")
  const markers = [...normalized.matchAll(/(?:^|\n)User request:\n/g)]
  if (!markers.length) return parseLeadingSnapshotHeader(normalized)
  for (const marker of markers.reverse()) {
    const snapshotID = parseLeadingSnapshotHeader(normalized.slice(marker.index! + marker[0].length))
    if (snapshotID !== null) return snapshotID
  }
  return null
}

/** Inspect the last valid fenced plan, retaining oversized groups for UI diagnostics. */
export function inspectCommitAgentPlan(text: string): CommitAgentPlanInspection | null {
  let result: CommitAgentPlanInspection | null = null
  const blocks = /^[\t ]*```commit-plan[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*\r?$/gm
  for (const match of text.matchAll(blocks)) {
    try {
      const value: unknown = JSON.parse(match[1])
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const { scope, commits } = value as { scope?: unknown; commits?: unknown }
      if (scope !== undefined && scope !== "staged" && scope !== "working") continue
      if (!Array.isArray(commits) || commits.length === 0 || commits.length > COMMIT_PLAN_MAX_GROUPS) continue
      const groups: { message: string; files: string[] }[] = []
      const violations: CommitAgentPlanViolation[] = []
      for (const entry of commits) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) break
        const { message, files } = entry
        if (typeof message !== "string" || !message.trim() || message.includes("\0") || message.trim().length > COMMIT_PLAN_MAX_MESSAGE_LENGTH || !Array.isArray(files) || !files.length || !files.every(file => typeof file === "string" && file.trim() && !file.includes("\0"))) break
        const trimmedMessage = message.trim()
        const dedupedFiles = [...new Set<string>(files)]
        if (dedupedFiles.length > COMMIT_PLAN_MAX_FILES_PER_GROUP) {
          violations.push({ groupIndex: groups.length, subject: trimmedMessage.split(/\r?\n/, 1)[0], fileCount: dedupedFiles.length, maxFiles: COMMIT_PLAN_MAX_FILES_PER_GROUP })
        }
        groups.push({ message: trimmedMessage, files: dedupedFiles })
      }
      if (groups.length === commits.length) result = { plan: { ...(scope === undefined ? {} : { scope }), commits: groups }, violations }
    } catch { /* Ignore malformed JSON and keep looking for the last valid plan. */ }
  }
  return result
}

/** Only plans within all execution limits may be parsed for approval. */
export function parseCommitAgentPlan(text: string): CommitAgentPlanInspection["plan"] | null {
  const inspection = inspectCommitAgentPlan(text)
  return inspection && inspection.violations.length === 0 ? inspection.plan : null
}
