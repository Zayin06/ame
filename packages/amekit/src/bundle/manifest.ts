// Adapted from opencode-amekit/src/bundle/manifest.ts; see ../docs/amekit.md for provenance.
import { z } from "zod"
import { readArchive } from "./archive"

import { BUNDLE_ARCHIVE_LIMITS, MAX_FILE, MAX_MANIFEST, MAX_PAYLOAD_FILES } from "./limits"
export { MAX_ZIP } from "./limits"
export const Version = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/).max(80)
export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const SkillId = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (s) => s === s.normalize("NFC") && !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(s) && s !== "." && s !== "..",
    "Invalid skill ID"
  )
export const ModelId = z.string().min(1).max(200).refine(s => s === s.normalize("NFC") && /^[^\s/\x00-\x1f\x7f]+$/.test(s), "Invalid model ID")
export const Features = z.object({
  commitEnhanceSkill: SkillId.optional(), commitEnhanceModel: ModelId.optional(),
  androidTranslationSkill: SkillId.optional(), androidTranslationModel: ModelId.optional(),
}).strict()
export type BundleFeatures = z.infer<typeof Features>
const File = z.object({ path: z.string().min(1).max(240), size: z.number().int().min(0).max(MAX_FILE), sha256: Hash }).strict()
const Manifest = z.object({
  schemaVersion: z.literal(1), target: z.literal("opencode"), version: Version, channel: z.literal("stable"),
  compatibility: z.object({ mode: z.enum(["native", "raw"]).optional(), testedOpenCode: z.array(Version).max(20) }).strict().refine(c => c.mode === "raw" || c.testedOpenCode.length > 0),
  agents: z.number().int().min(1).max(MAX_PAYLOAD_FILES), skills: z.number().int().min(1).max(MAX_PAYLOAD_FILES),
  files: z.array(File).min(2).max(MAX_PAYLOAD_FILES),
  features: Features.optional(),
}).strict()

export async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function validate(bytes: Uint8Array, version: string) {
  const inventory = new Map<string, { size: number; sha256: string }>()
  let manifest: z.infer<typeof Manifest> | undefined
  let agents = 0
  const skills = new Set<string>()
  const skillRoots = new Set<string>()
  for (const file of readArchive(bytes, {
    ...BUNDLE_ARCHIVE_LIMITS,
    allowPath: (path) => path === path.normalize("NFC") &&
      (path === "manifest.json" || /^(agents|skills)\//.test(path)) &&
      !/(^|\/)\.(?:env(?:\.|$)|git(?:\/|$))/i.test(path),
  })) {
    if (file.path !== file.path.normalize("NFC")) throw new Error("Đường dẫn phải là Unicode NFC")
    if (file.path === "manifest.json") {
      if (file.data.length > MAX_MANIFEST) throw new Error(`Manifest vượt ${Math.round(MAX_MANIFEST / 1048576)} MiB`)
      manifest = Manifest.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.data)))
      continue
    }
    if (!/^(agents|skills)\/.+/.test(file.path) || /(^|\/)\.(?:env(?:\.|$)|git(?:\/|$))/i.test(file.path))
      throw new Error("Bundle chỉ hỗ trợ agents/ và skills/, không nhận .env/.git")
    if (/^agents\/.+\.md$/.test(file.path)) agents++
    if (file.path.startsWith("skills/")) {
      const parts = file.path.split("/")
      if (parts.length < 3) throw new Error("Skill phải nằm trong skills/<name>/")
      skillRoots.add(parts[1]!)
      if (parts.length === 3 && parts[2] === "SKILL.md") skills.add(parts[1]!)
    }
    inventory.set(file.path, { size: file.data.length, sha256: await sha256(file.data) })
  }
  if (!manifest || manifest.version !== version || manifest.files.length !== inventory.size ||
      manifest.agents !== agents || manifest.skills !== skills.size || skills.size !== skillRoots.size)
    throw new Error("Manifest/version/inventory/count không khớp")
  for (const file of manifest.files) {
    const actual = inventory.get(file.path)
    if (!actual || actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error("Manifest hash/size/path không khớp")
    inventory.delete(file.path)
  }
  const features = manifest.features
  if (features?.commitEnhanceSkill && !skills.has(features.commitEnhanceSkill)) throw new Error("UNKNOWN_COMMIT_ENHANCE_SKILL")
  if (features?.androidTranslationSkill && !skills.has(features.androidTranslationSkill)) throw new Error("UNKNOWN_ANDROID_TRANSLATION_SKILL")
  return {
    schemaVersion: 1, target: "opencode", version, channel: "stable", compatibility: manifest.compatibility,
    ...(features && Object.values(features).some(value => value !== undefined) ? { features: Object.fromEntries(Object.entries(features).filter(([, value]) => value !== undefined)) as BundleFeatures } : {}),
    agents, skills: skills.size, fileCount: manifest.files.length,
    expandedSize: manifest.files.reduce((sum, file) => sum + file.size, 0),
  }
}
