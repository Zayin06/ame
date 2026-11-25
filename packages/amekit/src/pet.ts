import { z } from "zod"

export const petStates = ["idle", "thinking", "working", "waiting", "wave", "celebrating", "failed"] as const
export type PetState = typeof petStates[number]
export const petRows: Record<PetState, number> = { idle: 8, thinking: 0, working: 7, waiting: 6, wave: 3, celebrating: 4, failed: 5 }
export const petLabels: Record<PetState, string> = { idle: "Đang nghỉ", thinking: "Đang suy nghĩ", working: "Đang làm việc", waiting: "Đang chờ bạn", wave: "Đã hoàn thành", celebrating: "Ăn mừng", failed: "Có lỗi xảy ra" }
export type Point = { x: number; y: number }
export type Rectangle = Point & { width: number; height: number }
export type PetPreferences = { enabled: boolean; scale: number; position: Point | null }
export const defaultPetPreferences: PetPreferences = { enabled: false, scale: 0.25, position: null }
export type PetSpeechPreferences = { enabled: boolean; sound: boolean }
export type PetDialogueCache = { model: string; generatedAt: number; json: string }
export const petPreferencesSchema = z.object({
  enabled: z.boolean(), scale: z.number(),
  position: z.object({ x: z.number(), y: z.number() }).nullable(),
})
export const petSpeechPreferencesSchema = z.object({ enabled: z.boolean(), sound: z.boolean() })
export const petDialogueCacheSchema = z.object({
  model: z.string().min(1).max(200), generatedAt: z.number().nonnegative(), json: z.string().max(24 * 1024),
}).nullable()
export const petPersistenceSchema = z.object({
  preferences: petPreferencesSchema, speech: petSpeechPreferencesSchema, cache: petDialogueCacheSchema,
})
export function petScale(value: number): number { return Number.isFinite(value) ? Math.max(0.25, Math.min(2, value)) : defaultPetPreferences.scale }
export function petBounds(preferences: PetPreferences, areas: readonly Rectangle[], primary: Rectangle): Rectangle {
  const scale = petScale(preferences.scale)
  const width = Math.min(Math.round(192 * scale), primary.width), height = Math.min(Math.round(208 * scale), primary.height)
  const point = preferences.position
  const area = point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? areas.find(area => point.x >= area.x && point.y >= area.y && point.x < area.x + area.width && point.y < area.y + area.height)
    : undefined
  const target = area ?? primary
  const size = { width: Math.min(width, target.width), height: Math.min(height, target.height) }
  return { ...size, x: Math.round(area && point ? Math.min(point.x, target.x + target.width - size.width) : Math.max(target.x, target.x + target.width - size.width - 24)), y: Math.round(area && point ? Math.min(point.y, target.y + target.height - size.height) : Math.max(target.y, target.y + target.height - size.height - 24)) }
}
export type PetSession = {
  key: string; running: boolean; waiting: boolean; thinking: boolean; child: boolean
  outcome?: "succeeded" | "failed" | "interrupted"; busy?: number; idle?: number
}
export class PetActivity {
  private reports = new Map<string | number, readonly PetSession[]>()
  private previous = new Map<string, PetSession>()
  private started = new Map<string, number>()
  private effect?: { state: PetState; until: number }
  report(window: string | number, sessions: readonly PetSession[], now: number) { this.reports.delete(window); this.reports.set(window, sessions.map(session => ({ ...session }))); return this.update(now) }
  remove(window: string | number, now: number) { this.reports.delete(window); return this.update(now) }
  reset() { this.reports.clear(); this.previous.clear(); this.started.clear(); this.effect = undefined }
  update(now: number): PetState {
    if (this.effect && this.effect.until <= now) this.effect = undefined
    const sessions = new Map<string, PetSession>()
    for (const report of this.reports.values()) for (const session of report) {
      const existing = sessions.get(session.key)
      if (!existing || Math.max(session.busy ?? 0, session.idle ?? 0) >= Math.max(existing.busy ?? 0, existing.idle ?? 0)) sessions.set(session.key, session)
    }
    for (const session of sessions.values()) {
      const previous = this.previous.get(session.key)
      if (session.running && (!previous?.running || session.busy !== previous.busy)) {
        this.started.set(session.key, session.busy ?? now)
        if (this.effect?.state !== "failed") this.effect = undefined
      }
      // Idle/status can arrive before the execution outcome; allow that outcome once,
      // without replaying effects for an unchanged completed snapshot.
      const completed = previous && !session.running && session.idle !== undefined && session.idle >= (session.busy ?? 0) && (
        session.idle > Math.max(previous.idle ?? 0, previous.busy ?? 0) ||
        session.idle === previous.idle && previous.outcome === undefined && session.outcome !== undefined
      )
      if (completed && session.outcome === "failed") this.effect = { state: "failed", until: now + 4000 }
      else if (completed && !session.child && session.outcome === "succeeded" && this.effect?.state !== "failed") {
        const start = this.started.get(session.key) ?? session.busy
        const long = start !== undefined && session.idle! - start >= 20_000
        this.effect = { state: long ? "celebrating" : "wave", until: now + (long ? 2500 : 3000) }
      }
      if (!session.running) this.started.delete(session.key)
    }
    for (const key of this.started.keys()) if (!sessions.has(key)) this.started.delete(key)
    this.previous = sessions
    if (this.effect && this.effect.until > now) return this.effect.state
    this.effect = undefined
    if ([...sessions.values()].some(session => session.waiting)) return "waiting"
    if ([...sessions.values()].some(session => session.running && !session.thinking)) return "working"
    if ([...sessions.values()].some(session => session.running)) return "thinking"
    return "idle"
  }
}

export const petSpriteCss = `
.amekit-pet-sprite{width:100%;height:100%;background-size:600% 900%;background-repeat:no-repeat;animation:amekit-pet-frames 1833.333ms step-end infinite}
@keyframes amekit-pet-frames{0%,100%{background-position-x:0%}10%,90%{background-position-x:20%}20%,80%{background-position-x:40%}30%,70%{background-position-x:60%}40%,60%{background-position-x:80%}50%{background-position-x:100%}}
@media(prefers-reduced-motion:reduce){.amekit-pet-sprite{animation:none}}
`
export function validatePetSprite(sprite: string) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sprite)) throw new Error("INVALID_PET_SPRITE")
}
export async function loadPetSprite(pngPath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises")
  const bytes = await readFile(pngPath)
  if (!bytes.subarray(0, 8).equals(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10))) throw new Error("INVALID_PET_SPRITE")
  const sprite = `data:image/png;base64,${bytes.toString("base64")}`
  validatePetSprite(sprite)
  return sprite
}
export function petHtml(sprite = ""): string {
  if (sprite) validatePetSprite(sprite)
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'none'"><title>AmeKit Pet</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body{user-select:none;touch-action:none}${petSpriteCss}.amekit-pet-sprite{background-image:url('${sprite}');background-position-y:100%}</style></head><body><div class="amekit-pet-sprite" role="img" aria-label="AME Chibi — Đang nghỉ"></div></body></html>`
}
