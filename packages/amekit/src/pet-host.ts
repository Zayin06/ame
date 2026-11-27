import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron"
import { defaultPetPreferences, PetActivity, petBounds, petHtml, petLabels, petRows, petScale, petPersistenceSchema, validatePetSprite, type PetPreferences, type PetState, type PetSession, type PetSpeechPreferences, type PetDialogueCache } from "./pet"
import { defaultPetPalette, petPalette, petPaletteScript, petBubbleBounds, type PetPalette } from "./pet-appearance"
import { localDialogue, parseDialogue, PetSpeech, petBubbleHtml, type DialogueSet } from "./pet-dialogue"
import { petChime } from "./pet-chime"
import { PetInteraction } from "./pet-interaction"

export type PetHostState = {
  preferences: PetPreferences
  activity: PetState
  error: string
  speech: PetSpeechPreferences
  generating: boolean
  dialogueModel: string
  generatedAt: number
}
export type PetHostOptions = {
  userData: string
  electron: Pick<typeof import("electron"), "BrowserWindow" | "screen">
  sprite: string
  defaultEnabled?: boolean
  hasMainWindow: () => boolean
  interactionPreload?: string
  onActivate?: () => void
  onStateChanged?: (state: PetHostState) => void
  generateDialogue?: (model: string, signal: AbortSignal) => Promise<DialogueSet>
}

export function createPetHost(options: PetHostOptions) {
  const { electron } = options
  const file = join(options.userData, "desktop-pet.json")
  const activity = new PetActivity(), speaker = new PetSpeech(), lifetime = new AbortController()
  const chime = petChime()
  let preferences: PetPreferences = { ...defaultPetPreferences, enabled: options.defaultEnabled ?? defaultPetPreferences.enabled }
  let speech: PetSpeechPreferences = { enabled: true, sound: true }
  let cache: PetDialogueCache | null = null, dialogue = localDialogue, palette = defaultPetPalette
  let currentState: PetState = "idle", error = "", generating = false, initialized = false, disposed = false
  let window: BrowserWindow | undefined, bubble: BrowserWindow | undefined
  let ready = false, changingBounds = false, bubbleReady = false, bubbleHeight = 146, bubbleUntil = 0, lastChime = -Infinity
  let saveTimer: ReturnType<typeof setTimeout> | undefined, timer: ReturnType<typeof setInterval> | undefined

  function state(): PetHostState {
    return { preferences: { ...preferences, position: preferences.position && { ...preferences.position } }, activity: currentState,
      error, speech: { ...speech }, generating, dialogueModel: cache?.model ?? "", generatedAt: cache?.generatedAt ?? 0 }
  }
  const changed = () => { if (!disposed) options.onStateChanged?.(state()) }
  function ensureActive() { if (disposed) throw new Error("PET_HOST_DISPOSED") }
  function persist() {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const value = petPersistenceSchema.parse({ preferences, speech, cache })
      mkdirSync(options.userData, { recursive: true })
      writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 })
      renameSync(temporary, file)
    } catch (cause) {
      error = "Không thể lưu cài đặt pet trên máy này."
      throw cause
    } finally {
      try { unlinkSync(temporary) } catch { /* A successful rename already removed the temporary file. */ }
    }
  }
  function persistPosition() {
    if (!window || window.isDestroyed()) return
    const { x, y } = window.getBounds()
    preferences = { ...preferences, position: { x, y } }
    try { persist() } catch { /* Keep the live position and expose the persistence error. */ }
    changed()
  }
  function flushPosition() {
    if (!saveTimer) return
    clearTimeout(saveTimer); saveTimer = undefined; persistPosition()
  }
  function closeBubble() {
    bubbleReady = false; bubbleUntil = 0
    const previous = bubble; bubble = undefined
    if (previous && !previous.isDestroyed()) previous.destroy()
  }
  function close() {
    closeBubble(); speaker.reset(); flushPosition()
    const previous = window; window = undefined; ready = false
    if (previous && !previous.isDestroyed()) previous.destroy()
  }
  function fail() {
    error = "Không thể hiển thị pet. Hãy thử tắt/bật lại trong Cài đặt."
    close(); changed()
  }
  function paint() {
    if (!ready || !window || window.isDestroyed()) return
    const current = window
    void current.webContents.executeJavaScript(`var pet=document.querySelector('.amekit-pet-sprite');pet.style.backgroundPositionY=${JSON.stringify(`${petRows[currentState] * 12.5}%`)};pet.setAttribute('aria-label',${JSON.stringify(`AME Chibi — ${petLabels[currentState]}`)})`).catch(() => { if (!disposed && window === current) fail() })
  }
  function setState(next: PetState) {
    if (currentState === next) return
    currentState = next; paint(); changed()
  }
  function bounds() {
    return petBounds(preferences, electron.screen.getAllDisplays().map(display => display.workArea), electron.screen.getPrimaryDisplay().workArea)
  }
  function placeBubble() {
    if (!bubble || bubble.isDestroyed() || !window || window.isDestroyed()) return
    const pet = window.getBounds()
    const area = electron.screen.getAllDisplays().map(display => display.workArea).find(area => pet.x >= area.x && pet.x < area.x + area.width && pet.y >= area.y && pet.y < area.y + area.height) ?? electron.screen.getPrimaryDisplay().workArea
    const layout = petBubbleBounds(pet, area, bubbleHeight)
    bubble.setBounds(layout.bounds)
    if (bubbleReady) return bubble.webContents.executeJavaScript(`${petPaletteScript(palette)};document.documentElement.dataset.side=${JSON.stringify(layout.side)};document.documentElement.style.setProperty('--bubble-anchor',${JSON.stringify(`${layout.anchor}px`)})`).catch(() => {})
  }
  function lockSize(win: BrowserWindow, width: number, height: number) {
    win.setMinimumSize?.(width, height)
    win.setMaximumSize?.(width, height)
  }
  function place() {
    if (!window || window.isDestroyed()) return
    // Commit a pending user drag before a display change can clamp the live window.
    flushPosition()
    const target = bounds()
    changingBounds = true
    try { lockSize(window, target.width, target.height); window.setBounds(target); void placeBubble() } finally { changingBounds = false }
  }
  function secure(current: BrowserWindow) {
    current.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    current.webContents.on("will-navigate", event => event.preventDefault())
  }
  const windowOptions: BrowserWindowConstructorOptions = {
    show: false, transparent: true, backgroundColor: "#00000000", frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, maximizable: false,
    minimizable: false, fullscreenable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
  }
  function say(text: string, sound: boolean) {
    if (disposed || !ready || !window || window.isDestroyed() || !speech.enabled) return
    closeBubble()
    try {
      const current = new electron.BrowserWindow({ ...windowOptions, width: 286, height: 146, title: "AME — Lời thoại" })
      bubble = current; bubbleHeight = 146
      secure(current); current.setIgnoreMouseEvents(true)
      current.on("closed", () => { if (bubble === current) { bubble = undefined; bubbleReady = false } })
      current.webContents.on("render-process-gone", () => { if (bubble === current) closeBubble() })
      void placeBubble()
      void current.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(petBubbleHtml())}`).then(async () => {
        if (disposed || bubble !== current || current.isDestroyed()) return
        const measured: unknown = await current.webContents.executeJavaScript(`document.querySelector('.bubble').textContent=${JSON.stringify(text)};${petPaletteScript(palette)};Math.ceil(document.body.getBoundingClientRect().height)`)
        if (disposed || bubble !== current || current.isDestroyed()) return
        if (typeof measured !== "number" || !Number.isFinite(measured) || measured <= 0) throw new Error("INVALID_PET_BUBBLE_SIZE")
        bubbleHeight = measured; bubbleReady = true; bubbleUntil = Date.now() + 8000
        await placeBubble()
        if (disposed || bubble !== current || current.isDestroyed()) return
        current.showInactive()
        if (sound && speech.sound && ready && window && !window.isDestroyed() && Date.now() - lastChime >= 5000) {
          lastChime = Date.now()
          void window.webContents.executeJavaScript("var bell=document.querySelector('audio');bell.currentTime=0;bell.play().catch(()=>{})").catch(() => {})
        }
      }).catch(() => { if (bubble === current) closeBubble() })
    } catch { closeBubble() }
  }
  function reconcile() {
    if (!initialized || disposed) return
    if (!preferences.enabled || !options.hasMainWindow()) {
      close()
      if (!options.hasMainWindow()) { activity.reset(); setState("idle") }
      return
    }
    if (window && !window.isDestroyed()) { place(); return }
    try {
      validatePetSprite(options.sprite)
      const initial = bounds()
      const current = new electron.BrowserWindow({ ...windowOptions, ...initial,
        minWidth: initial.width, maxWidth: initial.width, minHeight: initial.height, maxHeight: initial.height, title: "AmeKit Pet",
        webPreferences: { ...windowOptions.webPreferences, preload: options.interactionPreload } })
      window = current; secure(current)
      const interaction = new PetInteraction()
      current.webContents.on("ipc-message", (event, channel, ...args: unknown[]) => {
        if (disposed || !ready || window !== current || current.isDestroyed() || event.senderFrame !== current.webContents.mainFrame) return
        if (channel !== "ame:pet-pointer" || args.length !== 1) return
        const phase = args[0]
        if (phase !== "down" && phase !== "move" && phase !== "up" && phase !== "cancel") return
        const result = interaction.update(phase, electron.screen.getCursorScreenPoint(), current.getBounds(), Date.now())
        if (result.position) {
          // Moving with setPosition can accumulate DIP/pixel rounding errors on Windows.
          // Always restore the size derived from preferences, never the native window size.
          const { width, height } = bounds()
          lockSize(current, width, height)
          current.setBounds({ x: Math.round(result.position.x), y: Math.round(result.position.y), width, height })
        }
        if (result.activate && options.hasMainWindow()) options.onActivate?.()
      })
      current.webContents.on("render-process-gone", () => { if (window === current) fail() })
      current.on("closed", () => {
        if (window !== current) return
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = undefined; window = undefined; ready = false; closeBubble(); speaker.reset()
      })
      const onBoundsChanged = () => {
        if (disposed || changingBounds || window !== current) return
        const cur = current.getBounds(), expected = bounds()
        if (cur.width !== expected.width || cur.height !== expected.height) {
          changingBounds = true
          try {
            lockSize(current, expected.width, expected.height)
            current.setBounds({ x: cur.x, y: cur.y, width: expected.width, height: expected.height })
          } finally { changingBounds = false }
        }
        void placeBubble()
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => { saveTimer = undefined; persistPosition() }, 400)
      }
      current.on("moved", onBoundsChanged)
      current.on("resized", onBoundsChanged)
      // Keep the URL small; Chromium rejects data URLs containing the full sprite sheet.
      void current.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(petHtml())}`).then(async () => {
        if (disposed || window !== current || current.isDestroyed()) return
        await current.webContents.executeJavaScript(`document.querySelector('.amekit-pet-sprite').style.backgroundImage=${JSON.stringify(`url("${options.sprite}")`)}`)
        if (disposed || window !== current || current.isDestroyed()) return
        await current.webContents.executeJavaScript(`var bell=document.createElement('audio');bell.src=${JSON.stringify(chime)};bell.preload='auto';document.body.appendChild(bell)`)
        if (disposed || window !== current || current.isDestroyed()) return
        ready = true; paint(); current.showInactive()
      }).catch(() => { if (!disposed && window === current) fail() })
    } catch { fail() }
  }
  const onDisplay = () => { place() }
  async function init(): Promise<PetHostState> {
    ensureActive()
    if (initialized) return state()
    try {
      const stored = petPersistenceSchema.parse(JSON.parse(readFileSync(file, "utf8")))
      const lines = stored.cache ? parseDialogue(JSON.parse(stored.cache.json)) : localDialogue
      preferences = { ...stored.preferences, scale: petScale(stored.preferences.scale) }
      speech = stored.speech; cache = stored.cache; dialogue = lines
    } catch { /* Missing, corrupt or invalid settings leave clean defaults in place. */ }
    initialized = true
    electron.screen.on("display-added", onDisplay)
    electron.screen.on("display-removed", onDisplay)
    electron.screen.on("display-metrics-changed", onDisplay)
    timer = setInterval(() => {
      setState(activity.update(Date.now()))
      if (bubbleReady && Date.now() >= bubbleUntil) closeBubble()
      if (ready && speech.enabled) {
        const next = speaker.next(currentState, Date.now(), dialogue)
        if (next) say(next.text, next.chime)
      }
    }, 200)
    timer.unref()
    reconcile(); changed(); return state()
  }
  async function configure(input: { enabled?: boolean; scale?: number; resetPosition?: boolean }): Promise<PetHostState> {
    ensureActive(); flushPosition()
    preferences = { ...preferences, enabled: input.enabled ?? preferences.enabled, scale: input.scale === undefined ? preferences.scale : petScale(input.scale), position: input.resetPosition ? null : preferences.position }
    error = ""
    try { persist(); reconcile() } finally { changed() }
    return state()
  }
  async function configureSpeech(input: { enabled?: boolean; sound?: boolean }): Promise<PetHostState> {
    ensureActive()
    speech = { enabled: input.enabled ?? speech.enabled, sound: input.sound ?? speech.sound }
    if (!speech.enabled) closeBubble()
    if ((!speech.enabled || !speech.sound) && ready && window && !window.isDestroyed()) void window.webContents.executeJavaScript("document.querySelector('audio')?.pause()").catch(() => {})
    speaker.reset(); error = ""
    try { persist() } finally { changed() }
    return state()
  }
  async function generate(model: string): Promise<PetHostState> {
    ensureActive()
    if (generating) throw new Error("PET_GENERATION_BUSY")
    if (!options.generateDialogue || !model.trim() || model.length > 200) throw new Error("PET_MODEL_REQUIRED")
    generating = true; error = ""; changed()
    try {
      const lines = parseDialogue(await options.generateDialogue(model, lifetime.signal))
      lifetime.signal.throwIfAborted()
      const previous = cache
      cache = { model, generatedAt: Date.now(), json: JSON.stringify(lines) }
      try { persist() } catch (cause) { cache = previous; throw cause }
      dialogue = lines
    } catch {
      if (!disposed) error = "Không tạo được lời thoại. Vẫn giữ lời thoại đã lưu trước đó."
      throw new Error("PET_GENERATION_FAILED")
    } finally { generating = false; changed() }
    return state()
  }
  function dispose() {
    if (disposed) return
    disposed = true; lifetime.abort(); if (timer) clearInterval(timer)
    if (initialized) {
      electron.screen.removeListener("display-added", onDisplay)
      electron.screen.removeListener("display-removed", onDisplay)
      electron.screen.removeListener("display-metrics-changed", onDisplay)
    }
    close(); activity.reset()
  }
  return {
    init, state, configure, speech: configureSpeech, generate, reconcile, dispose,
    theme(value: PetPalette) { ensureActive(); palette = petPalette(value); if (bubbleReady) void placeBubble() },
    report(windowKey: string, sessions: readonly PetSession[]): PetState { ensureActive(); setState(activity.report(windowKey, sessions, Date.now())); return currentState },
    removeWindow(windowKey: string): PetState { ensureActive(); setState(activity.remove(windowKey, Date.now())); return currentState },
    testSpeech() { ensureActive(); if (speech.enabled && ready) say(dialogue.greeting[0], true) },
  }
}
