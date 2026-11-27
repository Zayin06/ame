// Adapted from opencode-amekit/src/bundle/package.ts; see ../docs/amekit.md for provenance.
import { zipSync, type Zippable } from "fflate"
import { parseDocument, stringify } from "yaml"
import { Features, MAX_ZIP, Version, sha256, validate, type BundleFeatures } from "./manifest"
import { readArchive } from "./archive"
import { BUNDLE_ARCHIVE_LIMITS, MAX_EXPANDED, MAX_FILE, MAX_PAYLOAD_FILES } from "./limits"
import { z } from "zod"
export type ImportOptions = { compatibilityMode?: "native" | "raw"; adaptClaudeAgents?: boolean }
const managedLevelRef = /^amecode\/(default|haiku|sonnet|opus)$/
const CLAUDE_COLOR_HEX: Record<string, string> = {
  green: "#22c55e", blue: "#3b82f6", orange: "#f97316", purple: "#a855f7", red: "#ef4444", yellow: "#eab308",
  cyan: "#06b6d4", pink: "#ec4899", teal: "#14b8a6", indigo: "#6366f1", amber: "#f59e0b", emerald: "#10b981",
  violet: "#8b5cf6", rose: "#f43f5e", sky: "#0ea5e9", lime: "#84cc16", gray: "#6b7280", grey: "#6b7280",
}
function adaptClaudeFrontmatter(value: Record<string, unknown>) {
  const adapted = { ...value }, changes: string[] = []
  if ("name" in adapted) { delete adapted.name; changes.push("removed name") }
  if ("tools" in adapted) { delete adapted.tools; changes.push("removed tools") }
  if (typeof adapted.model === "string" && adapted.model.trim().toLowerCase() === "inherit") { delete adapted.model; changes.push("removed model: inherit") }
  if (typeof adapted.model === "string") {
    const rawModel = adapted.model.trim()
    const match = /^(?:amecode\/)?(default|haiku|sonnet|opus)$/i.exec(rawModel)
    if (match) {
      const normalized = `amecode/${match[1].toLowerCase()}`
      if (adapted.model !== normalized) { adapted.model = normalized; changes.push(`model ${rawModel} -> ${normalized}`) }
    }
  }
  if ("color" in adapted) {
    if (typeof adapted.color === "string") {
      const c = adapted.color.trim()
      if (/^#[0-9a-fA-F]{6}$/.test(c)) {
        if (c !== adapted.color) { adapted.color = c; changes.push("trimmed color") }
      } else if (Object.hasOwn(CLAUDE_COLOR_HEX, c.toLowerCase())) {
        const hex = CLAUDE_COLOR_HEX[c.toLowerCase()]
        adapted.color = hex; changes.push(`color ${c} -> ${hex}`)
      } else { delete adapted.color; changes.push("removed unsupported color") }
    } else { delete adapted.color; changes.push("removed invalid color") }
  }
  if (adapted.mode === undefined) { adapted.mode = "all"; changes.push("mode: all") }
  return { adapted, changes }
}
// Mirrors the accepted, portable subset of ConfigAgent.Info 2.3.2; parity-tested against the public schema.
const agentMetadata = z.object({
  description: z.string(), mode: z.enum(["all", "primary", "subagent"]).optional(), system: z.string().optional(),
  model: z.string().regex(managedLevelRef).optional(),
  hidden: z.boolean().optional(), disabled: z.boolean().optional(), steps: z.number().int().positive().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "deny", "ask"]) }).strict()).optional(),
  request: z.object({ headers: z.record(z.string(), z.string()).optional(), body: z.record(z.string(), z.json()).optional() }).strict().optional(),
}).strict()

export type InputFile = { path: string; data: Uint8Array }
export type Issue = { path: string; severity: "error" | "warning" | "excluded" | "change"; reason: string }
export type Preview = { files: InputFile[]; issues: Issue[]; agents: string[]; skills: string[]; compatibilityMode?: "native" | "raw" }
const utf8 = new TextDecoder("utf-8", { fatal: true })
const encode = new TextEncoder()
export function safePath(name: string) {
  const parts = name.split("/")
  if (!name || name !== name.normalize("NFC") || encode.encode(name).length > 240 || parts.length > 16 ||
    /[\\:\x00-\x1f\x7f]/.test(name) || parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("UNSAFE_PATH: " + name)
}
export function exclusion(name: string, options: ImportOptions = {}) {
  const parts = name.split("/")
  if (parts.some(p => /^(\.git|\.env(?:\..*)?|\.ssh|\.aws|node_modules|__pycache__|\.cache|\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)$/i.test(p)) ||
    (options.compatibilityMode === "raw" && parts.some(p => /^\.gradle$/i.test(p))) ||
    (options.compatibilityMode !== "raw" && parts.some(p => /^(dist|build)$/i.test(p)))) return "metadata/cache/build/credential path"
  if (/\.(pem|key|pfx|p12)$/i.test(name) || /(^|\/)(credentials|id_rsa|id_ed25519|auth\.json)$/i.test(name)) return "credential file"
}
const CODE_FENCE_LANGS = new Set([
  "ts", "typescript", "js", "javascript", "tsx", "jsx", "svelte",
  "kotlin", "java", "py", "python", "go", "rust", "swift", "dart",
  "c", "cpp", "csharp", "cs", "php", "ruby", "rb", "scala",
])
export function secretFindings(text: string) {
  const findings: { rule: "private-key" | "provider-key" | "assignment"; classification: "blocked" | "template" | "code-expression" }[] = []
  if (/-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----/i.test(text)) findings.push({ rule: "private-key", classification: "blocked" })
  for (const _ of text.matchAll(/\b(?:sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi)) findings.push({ rule: "provider-key", classification: "blocked" })
  for (const match of text.matchAll(/\bBearer\s+(?!\[REDACTED_)([A-Za-z0-9._~+\/-]+=*)/gi)) {
    findings.push({ rule: "provider-key", classification: /^(?:YOUR_[A-Z0-9_]+|INSERT_[A-Z0-9_]+_HERE)$/.test(match[1]) ? "template" : "blocked" })
  }
  for (const match of text.matchAll(/(?:api[_-]?key|password|secret|token)\s*[:=]\s*(["']?)([A-Za-z0-9_+\/=-]{16,})/gi)) {
    const value = match[2], rest = text.slice(match.index! + match[0].length)
    const boundary = match[1] ? rest.startsWith(match[1]) : /^(?:\s|$|[,;}\]"'])/.test(rest)
    const template = boundary && (/^YOUR_[A-Z0-9_]+$/.test(value) || /^INSERT_[A-Z0-9_]+_HERE$/.test(value) || /^your_[a-z_]+$/.test(value))
    // Restrict code-expression exceptions to language-tagged examples, never quoted literals.
    const fences = [...text.slice(0, match.index).matchAll(/^```([^\r\n]*)/gm)]
    const fenceLang = fences.length % 2 === 1 ? (fences.at(-1)?.[1].trim().split(/\s+/)[0]?.toLowerCase() ?? "") : ""
    const inCodeFence = CODE_FENCE_LANGS.has(fenceLang)
    const envIdentifier = !match[1] && boundary && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value)
    const expression = inCodeFence && !match[1] && ((fenceLang === "kotlin" && /^[A-Za-z_]\w*$/.test(value) && /^(?:\.[A-Za-z_]\w*)*\s*\(/.test(rest)) || envIdentifier)
    findings.push({ rule: "assignment", classification: template ? "template" : expression ? "code-expression" : "blocked" })
  }
  return findings
}
function frontmatter(file: InputFile) {
  const text = utf8.decode(file.data)
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error("MISSING_FRONTMATTER")
  const doc = parseDocument(match[1], { uniqueKeys: true })
  if (doc.errors.length) throw new Error("INVALID_FRONTMATTER")
  const value = doc.toJS() as Record<string, unknown>
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_FRONTMATTER")
  return { value, body: text.slice(match[0].length), text }
}
export function preview(input: InputFile[], inherited: Issue[] = [], options: ImportOptions = {}): Preview {
  if (options.compatibilityMode !== undefined && options.compatibilityMode !== "native" && options.compatibilityMode !== "raw") throw new Error("INVALID_COMPATIBILITY_MODE")
  if (options.adaptClaudeAgents === true && options.compatibilityMode !== "raw") throw new Error("INVALID_COMPATIBILITY_MODE")
  const raw = options.compatibilityMode === "raw"
  const semanticSeverity = raw ? "warning" : "error"
  const issues = [...inherited]
  if (raw) issues.push({ path: "", severity: "warning", reason: "raw mode: exact retained payload bytes; compatibility is not guaranteed and runtime discovery is not required" })
  const files: InputFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const file of [...input].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    try { safePath(file.path) } catch { issues.push({ path: file.path, severity: "error", reason: "unsafe path" }); continue }
    const excluded = exclusion(file.path, options)
    if (excluded) { issues.push({ path: file.path, severity: "excluded", reason: excluded }); continue }
    if (!/^(agents|skills)\//.test(file.path)) { issues.push({ path: file.path, severity: "error", reason: "meaningful content outside supported agents/ and skills/; choose an export root" }); continue }
    const key = file.path.toLowerCase()
    if (seen.has(key)) issues.push({ path: file.path, severity: "error", reason: "case-insensitive duplicate" })
    if ([...seen].some(p => p.startsWith(key + "/") || key.startsWith(p + "/"))) issues.push({ path: file.path, severity: "error", reason: "file-directory collision" })
    seen.add(key)
    total += file.data.length
    if (file.data.length > MAX_FILE) issues.push({ path: file.path, severity: "error", reason: "file exceeds 4 MiB" })
    const text = new TextDecoder().decode(file.data)
    const findings = secretFindings(text)
    if (findings.some(f => !raw || f.classification === "blocked")) issues.push({ path: file.path, severity: "error", reason: "likely embedded secret; review source before export" })
    if (raw && findings.some(f => f.classification !== "blocked")) issues.push({ path: file.path, severity: "warning", reason: "secret-like assignment classified as explicit template or unquoted code call; values preserved, review before export" })
    files.push({ path: file.path, data: file.data.slice() })
  }
  const paths = new Set(files.map(f => f.path))
  const agents: string[] = [], skills: string[] = []
  const ids = new Set<string>()
  for (const file of files) {
    const agent = /^agents\/(.+)\.md$/.exec(file.path)
    const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)
    if (agent || skill) {
      const id = agent?.[1] ?? skill![1]
      const key = `${agent ? "agent" : "skill"}:${id.toLowerCase()}`
      if (ids.has(key)) issues.push({ path: file.path, severity: "error", reason: "duplicate ID" })
      ids.add(key)
      ;(agent ? agents : skills).push(id)
      try {
        let { value, body } = frontmatter(file)
        if (typeof value.description !== "string" || !value.description.trim()) throw new Error("description required")
        if (agent && raw && options.adaptClaudeAgents === true) {
          const { adapted, changes } = adaptClaudeFrontmatter(value)
          if (changes.length) {
            const previousSize = file.data.length
            file.data = encode.encode(`---\n${stringify(adapted)}---\n${body}`)
            total += file.data.length - previousSize
            if (previousSize <= MAX_FILE && file.data.length > MAX_FILE) issues.push({ path: file.path, severity: "error", reason: "file exceeds 4 MiB" })
            issues.push({ path: file.path, severity: "change", reason: `adapted Claude frontmatter for OpenCode 2.3.2 (${changes.join(", ")}); instruction body preserved` })
          }
          value = adapted
        }
        if (skill && (value.name !== id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error("skill name must match directory and use lowercase hyphenated name")
        const unsupported = agent ? Object.keys(value).filter(k => !["description", "mode", "model", "request", "system", "steps", "hidden", "disabled", "color", "permissions", "name"].includes(k)) : []
        const isManagedTier = typeof value.model === "string" && managedLevelRef.test(value.model)
        if (agent && raw && value.model !== undefined && !isManagedTier) issues.push({ path: file.path, severity: "warning", reason: "pinned model metadata preserved; provider/model availability and interpretation are not verified" })
        if (unsupported.length) throw new Error("unsupported metadata: " + unsupported.join(", "))
        if (agent && typeof value.tools === "string") throw new Error("Claude tools require explicit capability audit; no automatic grants")
        if (agent && value.mode !== undefined && !["all", "primary", "subagent"].includes(String(value.mode))) throw new Error("invalid agent mode")
        if (agent && !raw && value.model !== undefined && !isManagedTier) issues.push({ path: file.path, severity: "error", reason: "model dependency requires explicit supported provider adapter; remove pinned model from export" })
        if (agent) {
          const { name, ...native } = value
          try { agentMetadata.parse(native) }
          catch { throw new Error("invalid OpenCode 2.3.2 agent metadata") }
        }
        if (!raw && agent && value.name !== undefined) {
          delete value.name
          file.data = encode.encode(`---\n${stringify(value)}---\n${body}`)
          issues.push({ path: file.path, severity: "change", reason: "removed source name metadata; OpenCode ID comes from relative path; instruction body preserved" })
        }
      } catch (error) { issues.push({ path: file.path, severity: semanticSeverity, reason: String(error instanceof Error ? error.message : error) }) }
    }
    if (/\.(md|txt|yaml|yml|json)$/i.test(file.path)) {
      const text = new TextDecoder().decode(file.data)
      for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
        const ref = match[1].split("#")[0]
        if (!ref || /^[a-z][a-z0-9+.-]*:|^#/i.test(ref)) continue
        const parts = file.path.split("/"); parts.pop()
        let invalid = false
        for (const part of ref.split("/")) { if (part === "..") { if (!parts.length) invalid = true; parts.pop() } else if (part !== "." && part) parts.push(part) }
        if (invalid || !paths.has(parts.join("/"))) issues.push({ path: file.path, severity: semanticSeverity, reason: "missing/unsafe local reference: " + ref })
      }
      if (/\b(?:mcp__|subagent_type\s*[:=]|\.claude\/)/.test(text)) issues.push({ path: file.path, severity: semanticSeverity, reason: "unresolved external runtime/delegation dependency; explicit audit required" })
    }
    if (file.path.startsWith("skills/")) {
      const root = file.path.split("/")[1]
      if (!paths.has(`skills/${root}/SKILL.md`)) issues.push({ path: file.path, severity: "error", reason: "missing skill entrypoint" })
    }
  }
  if (!agents.length || !skills.length) issues.push({ path: "", severity: "error", reason: "bundle requires at least one agent and one skill" })
  if (files.length > MAX_PAYLOAD_FILES) issues.push({ path: "", severity: "error", reason: `more than ${MAX_PAYLOAD_FILES} payload entries` })
  if (total > MAX_EXPANDED) issues.push({ path: "", severity: "error", reason: `expanded payload exceeds ${Math.round(MAX_EXPANDED / 1048576)} MiB` })
  return { files, issues, agents, skills, ...(raw ? { compatibilityMode: "raw" as const } : {}) }
}
export async function pack(source: Preview, version: string, signal?: AbortSignal, options: BundleFeatures = {}) {
  signal?.throwIfAborted()
  Version.parse(version)
  if (source.issues.some(i => i.severity === "error")) throw new Error("IMPORT_BLOCKED")
  const features = Features.parse(Object.fromEntries(Object.entries(options).map(([key, value]) => [key, typeof value === "string" ? value.trim() || undefined : value]).filter(([, value]) => value !== undefined)))
  if (features.commitEnhanceSkill && !source.skills.includes(features.commitEnhanceSkill)) throw new Error("UNKNOWN_COMMIT_ENHANCE_SKILL")
  if (features.androidTranslationSkill && !source.skills.includes(features.androidTranslationSkill)) throw new Error("UNKNOWN_ANDROID_TRANSLATION_SKILL")
  if (features.buildNotesSkill && !source.skills.includes(features.buildNotesSkill)) throw new Error("UNKNOWN_BUILD_NOTES_SKILL")
  const files = [...source.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const inventory = await Promise.all(files.map(async f => ({ path: f.path, size: f.data.length, sha256: await sha256(f.data) })))
  const manifest = { schemaVersion: 1, target: "opencode", version, channel: "stable", compatibility: source.compatibilityMode === "raw" ? { mode: "raw", testedOpenCode: [] } : { testedOpenCode: ["2.3.2"] }, agents: source.agents.length, skills: source.skills.length, files: inventory, ...(Object.keys(features).length ? { features } : {}) }
  const entries: Zippable = Object.create(null)
  // Fixed DOS timestamp and no directory entries keep output deterministic and strict.
  for (const f of [...files, { path: "manifest.json", data: encode.encode(JSON.stringify(manifest)) }]) {
    signal?.throwIfAborted()
    entries[f.path] = [f.data, { level: 6, mtime: new Date(1980, 0, 1) }]
  }
  const bytes = zipSync(entries)
  if (bytes.length > MAX_ZIP) throw new Error("ZIP_EXCEEDS_32_MIB")
  const summary = await validate(bytes, version)
  return { bytes, sha256: await sha256(bytes), summary, entries: inventory.length + 1, expanded: summary.expandedSize + encode.encode(JSON.stringify(manifest)).length }
}
export async function verifiedFiles(bytes: Uint8Array, version: string, hash: string) {
  if (await sha256(bytes) !== hash) throw new Error("HASH_MISMATCH")
  const summary = await validate(bytes, version)
  if (summary.compatibility.mode !== "raw" && !summary.compatibility.testedOpenCode.includes("2.3.2")) throw new Error("UNTESTED_OPENCODE_VERSION")
  return { summary, files: [...readArchive(bytes, BUNDLE_ARCHIVE_LIMITS)].filter(f => f.path !== "manifest.json") }
}
