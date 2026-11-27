import assert from "node:assert/strict"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { defaultPetPreferences, loadPetSprite, PetActivity, petBounds, petHtml, petScale, petSpriteCss, type PetSession } from "../src/pet"
import { petBubbleBounds, petPalette, defaultPetPalette } from "../src/pet-appearance"
import { dialoguePrompt, localDialogue, parseDialogue, PetSpeech, petBubbleHtml } from "../src/pet-dialogue"
import { petChime } from "../src/pet-chime"
import { createPetHost, type PetHostOptions } from "../src/pet-host"
import { generatePetDialogue } from "../src/pet-generation"
import { PetInteraction, revealPetMainWindow } from "../src/pet-interaction"
import type { AmeApi } from "../src/api"

const area = { x: 0, y: 0, width: 1200, height: 800 }
const sprite = "data:image/png;base64,iVBORw0KGgo="
const session = (input: Partial<PetSession> = {}): PetSession => ({ key: "root", running: true, waiting: false, thinking: false, child: false, busy: 100, ...input })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test("scale and bounds clamp finite values across negative and removed displays", () => {
  assert.equal(petScale(NaN), 0.25); assert.equal(petScale(Infinity), 0.25)
  assert.equal(petScale(-1), 0.25); assert.equal(petScale(4), 2)
  const second = { x: -900, y: -100, width: 900, height: 700 }
  assert.deepEqual(petBounds({ enabled: true, scale: 1, position: { x: -10, y: 590 } }, [second, area], area), { x: -192, y: 392, width: 192, height: 208 })
  assert.deepEqual(petBounds({ ...defaultPetPreferences, position: { x: -100, y: 100 } }, [area], area), { x: 1128, y: 724, width: 48, height: 52 })
  const tiny = { x: 0, y: 0, width: 20, height: 10 }
  assert.deepEqual(petBounds({ ...defaultPetPreferences, scale: 2 }, [tiny], tiny), tiny)
})

test("activity follows root and arbitrary-depth children but celebrates root completions only", () => {
  const activity = new PetActivity()
  assert.equal(activity.report("one", [session({ thinking: true })], 100), "thinking")
  assert.equal(activity.report("two", [session({ key: "child", child: true })], 200), "working")
  assert.equal(activity.report("three", [session({ key: "grandchild", child: true, waiting: true })], 300), "waiting")
  activity.report("two", [session({ key: "child", child: true, running: false, idle: 1000, outcome: "succeeded" })], 1000)
  assert.equal(activity.report("three", [session({ key: "grandchild", child: true, running: false, idle: 1100, outcome: "succeeded" })], 1100), "thinking")
  assert.equal(activity.report("one", [session({ running: false, idle: 2000, outcome: "succeeded" })], 2000), "wave")
  assert.equal(activity.update(5000), "idle")
  activity.report("one", [session({ busy: 6000 })], 6000)
  assert.equal(activity.report("one", [session({ busy: 6000, running: false, idle: 26000, outcome: "succeeded" })], 26000), "celebrating")
  activity.update(30000)
  activity.report("one", [session({ busy: 31000 })], 31000)
  assert.equal(activity.report("one", [session({ running: false, busy: 31000, idle: 32000, outcome: "failed" })], 32000), "failed")
  assert.equal(activity.update(36000), "idle")
  activity.report("one", [session({ busy: 37000 })], 37000)
  assert.equal(activity.report("one", [session({ busy: 37000, running: false, idle: 38000, outcome: "interrupted" })], 38000), "idle")
  assert.equal(activity.remove("one", 39000), "idle")
  activity.reset(); assert.equal(activity.update(40000), "idle")
})

test("long-running child completion never celebrates but child failures remain visible", () => {
  const activity = new PetActivity()
  activity.report("main", [session(), session({ key: "deep-child", child: true })], 100)
  assert.equal(activity.report("main", [session(), session({ key: "deep-child", child: true, running: false, idle: 25000, outcome: "succeeded" })], 25000), "working")
  activity.report("main", [session(), session({ key: "deep-child", child: true, busy: 26000 })], 26000)
  assert.equal(activity.report("main", [session(), session({ key: "deep-child", child: true, busy: 26000, running: false, idle: 27000, outcome: "failed" })], 27000), "failed")
  assert.equal(activity.update(31000), "working")
})

test("activity merges newer reports and does not mutate retained snapshots", () => {
  const activity = new PetActivity(), mutable = session()
  activity.report("a", [mutable], 100)
  mutable.running = false; mutable.idle = 200; mutable.outcome = "succeeded"
  assert.equal(activity.report("a", [mutable], 200), "wave")
  activity.reset()
  activity.report("a", [session({ busy: 200 })], 200)
  assert.equal(activity.report("b", [session({ busy: 100, running: false })], 201), "working")
})

test("palette rejects CSS injection and bubbles flip, clamp and anchor", () => {
  assert.deepEqual(petPalette(defaultPetPalette), defaultPetPalette)
  for (const background of ["red;display:none", "url(https://x)", "#fff</style>", "var(--x)"]) assert.throws(() => petPalette({ ...defaultPetPalette, background }))
  assert.equal(petPalette({ ...defaultPetPalette, background: "rgba(20, 20, 20, 0.8)" }).background, "rgba(20, 20, 20, 0.8)")
  const above = petBubbleBounds({ x: 1150, y: 700, width: 48, height: 52 }, area, 100)
  assert.equal(above.side, "above"); assert.equal(above.bounds.x, 914); assert.equal(above.bounds.y, 596)
  assert.ok(above.anchor <= above.bounds.width - 22)
  const below = petBubbleBounds({ x: 0, y: 0, width: 48, height: 52 }, area, 100)
  assert.equal(below.side, "below"); assert.equal(below.bounds.x, 0); assert.equal(below.bounds.y, 56)
  const tiny = petBubbleBounds({ x: -20, y: -20, width: 10, height: 10 }, { x: -20, y: -20, width: 30, height: 20 }, 100)
  assert.deepEqual(tiny.bounds, { x: -20, y: -20, width: 30, height: 20 })
})

test("dialogue validates exact groups, distinct lines, length and unsafe text", () => {
  assert.deepEqual(parseDialogue(localDialogue), localDialogue)
  for (const line of ["<img>", "https://example.com", "www.example.com", "file://x", "a\u0000b", "a\u0085b", "\ntrimmed", "trailing\t", "x".repeat(121), " "]) {
    assert.throws(() => parseDialogue({ ...localDialogue, idle: [line, "An toàn"] }))
  }
  assert.throws(() => parseDialogue({ ...localDialogue, idle: ["Trùng", " Trùng "] }))
  assert.throws(() => parseDialogue({ ...localDialogue, extra: ["a", "b"] }))
  assert.throws(() => parseDialogue({ ...localDialogue, idle: ["a"] }))
  assert.throws(() => parseDialogue({ ...localDialogue, idle: Array.from({ length: 5 }, (_, i) => `${i}`) }))
  assert.equal(parseDialogue({ ...localDialogue, idle: ["x".repeat(120), "y"] }).idle[0].length, 120)
  assert.match(petBubbleHtml(), /script-src 'none'/)
  assert.match(petHtml(sprite), /script-src 'none'/)
  assert.throws(() => petHtml("https://example.com/pet.png"))
})

test("speech greets and respects important, long-running and idle cadence", () => {
  const speech = new PetSpeech()
  assert.equal(speech.next("idle", 0, localDialogue)?.text, localDialogue.greeting[0])
  assert.equal(speech.next("waiting", 100, localDialogue), undefined)
  assert.equal(speech.next("waiting", 1499, localDialogue), undefined)
  assert.equal(speech.next("waiting", 1500, localDialogue)?.chime, true)
  speech.reset()
  assert.ok(speech.next("working", 0, localDialogue))
  assert.equal(speech.next("working", 89999, localDialogue), undefined)
  assert.ok(localDialogue.long_running.includes(speech.next("working", 90000, localDialogue)!.text))
  assert.equal(speech.next("working", 180000, localDialogue), undefined)
  speech.reset(); speech.next("idle", 0, localDialogue)
  assert.equal(speech.next("waiting", 0, localDialogue), undefined)
  assert.equal(speech.next("waiting", 1500, localDialogue)?.chime, true)
  speech.reset(); speech.next("idle", 0, localDialogue)
  assert.equal(speech.next("idle", 119999, localDialogue), undefined)
  assert.ok(localDialogue.idle.includes(speech.next("idle", 120000, localDialogue)!.text))
})

test("chime is mono PCM16 WAV at 22.05kHz", () => {
  const uri = petChime(); assert.match(uri, /^data:audio\/wav;base64,/)
  const bytes = Buffer.from(uri.split(",")[1], "base64")
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF"); assert.equal(bytes.toString("ascii", 8, 16), "WAVEfmt ")
  assert.equal(bytes.readUInt16LE(20), 1); assert.equal(bytes.readUInt16LE(22), 1)
  assert.equal(bytes.readUInt32LE(24), 22050); assert.equal(bytes.readUInt16LE(34), 16)
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44)
})

test("loadPetSprite reads the actual byte-identical PNG", async () => {
  const path = fileURLToPath(new URL("../src/assets/ame-chibi.png", import.meta.url))
  const bytes = await readFile(path), uri = await loadPetSprite(path)
  assert.equal(bytes.length, 2052396)
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "408f268406bfdf6974b164bb331fb35b9d3fb22462eb14ccf383f288d0578740")
  assert.deepEqual(Buffer.from(uri.split(",")[1], "base64"), bytes)
  await assert.rejects(loadPetSprite(fileURLToPath(new URL("../src/pet.ts", import.meta.url))), /INVALID_PET_SPRITE/)
})

class MockWindow extends EventEmitter {
  static windows: MockWindow[] = []
  destroyed = false; shown = false; ignoreMouse = false; scripts: string[] = []; url = ""
  bounds = { x: 0, y: 0, width: 48, height: 52 }
  minimumSize = [0, 0]; maximumSize = [0, 0]; positionCalls = 0
  sizeLocks: { kind: string; size: number[] }[] = []
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    setWindowOpenHandler: (handler: () => { action: string }) => { this.openHandler = handler },
    executeJavaScript: async (code: string) => { this.scripts.push(code); return code.includes("getBoundingClientRect") ? 92 : undefined },
  })
  openHandler?: () => { action: string }
  constructor(readonly options: Record<string, any>) { super(); this.bounds = { ...this.bounds, ...Object.fromEntries(Object.entries(options).filter(([key]) => ["x", "y", "width", "height"].includes(key))) }; this.minimumSize = [options.minWidth ?? 0, options.minHeight ?? 0]; this.maximumSize = [options.maxWidth ?? 0, options.maxHeight ?? 0]; MockWindow.windows.push(this) }
  isDestroyed() { return this.destroyed }
  getBounds() { return { ...this.bounds } }
  setBounds(bounds: typeof this.bounds) { this.bounds = bounds; this.emit("moved") }
  setMinimumSize(width: number, height: number) { this.minimumSize = [width, height]; this.sizeLocks.push({ kind: "min", size: [width, height] }) }
  setMaximumSize(width: number, height: number) { this.maximumSize = [width, height]; this.sizeLocks.push({ kind: "max", size: [width, height] }) }
  setPosition(x: number, y: number) { this.positionCalls++; this.bounds = { x, y, width: this.bounds.width + 1, height: this.bounds.height + 1 }; this.emit("moved") }
  async loadURL(url: string) { this.url = url }
  showInactive() { this.shown = true }
  setIgnoreMouseEvents(value: boolean) { this.ignoreMouse = value }
  destroy() { this.destroyed = true; this.emit("closed") }
}
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, extra: Partial<PetHostOptions> = {}) {
  const userData = await mkdtemp(join(tmpdir(), "ame-pet-"))
  let cursor = { x: 100, y: 100 }
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [{ workArea: area }], getPrimaryDisplay: () => ({ workArea: area }), getCursorScreenPoint: () => ({ ...cursor }) })
  MockWindow.windows = []
  let main = true
  const host = createPetHost({ userData, sprite, electron: { BrowserWindow: MockWindow, screen } as unknown as PetHostOptions["electron"], hasMainWindow: () => main, ...extra })
  t.after(async () => { host.dispose(); await rm(userData, { recursive: true, force: true }) })
  return { host, userData, screen, setCursor(x: number, y: number) { cursor = { x, y } }, setMain(value: boolean) { main = value } }
}

test("pet short click reveals, restores and focuses the main window; dragging never activates", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 })
  const calls: string[] = []
  let minimized = true
  const main = { isDestroyed: () => false, isMinimized: () => minimized,
    restore() { calls.push("restore"); minimized = false }, show() { calls.push("show") }, focus() { calls.push("focus") } }
  const { host, setCursor, setMain, userData } = await fixture(t, {
    defaultEnabled: true, interactionPreload: "/preload/pet.cjs", onActivate: () => revealPetMainWindow(main),
  })
  await host.init(); await flush()
  const pet = MockWindow.windows[0]
  assert.equal(pet.options.webPreferences.preload, "/preload/pet.cjs")
  const pointer = (phase: string, frame = pet.webContents.mainFrame, channel = "ame:pet-pointer", ...extra: unknown[]) =>
    pet.webContents.emit("ipc-message", { senderFrame: frame }, channel, phase, ...extra)
  pointer("down"); t.mock.timers.tick(100); setCursor(102, 101); pointer("up")
  assert.deepEqual(calls.splice(0), ["restore", "show", "focus"])
  pointer("down"); pointer("up")
  assert.deepEqual(calls.splice(0), ["show", "focus"])

  const origin = pet.getBounds()
  pointer("down"); setCursor(152, 131); pointer("move")
  assert.deepEqual(pet.getBounds(), { ...origin, x: origin.x + 50, y: origin.y + 30 })
  pointer("up")
  assert.deepEqual(calls, [])
  // Moving away and back is still a drag, even on a very fast release.
  pointer("down"); setCursor(180, 131); pointer("move"); setCursor(152, 131); pointer("up")
  assert.deepEqual(calls, [])
  // The final release alone must also detect movement (coalesced move events).
  pointer("down"); setCursor(202, 131); pointer("up")
  assert.deepEqual(calls, [])
  host.dispose()
  const saved = JSON.parse(await readFile(join(userData, "desktop-pet.json"), "utf8"))
  assert.deepEqual(saved.preferences.position, { x: origin.x + 100, y: origin.y + 30 })
  pointer("down"); pointer("up"); assert.deepEqual(calls, [])
  setMain(false)
})

test("display removal preserves saved secondary coordinates and addition restores them", async t => {
  const { host, userData, screen } = await fixture(t)
  const second = { x: -1200, y: 0, width: 1200, height: 800 }
  let displays = [{ workArea: area }, { workArea: second }]
  screen.getAllDisplays = () => displays
  const position = { x: -600, y: 300 }
  const saved = JSON.stringify({ preferences: { ...defaultPetPreferences, position }, speech: { enabled: false, sound: false }, cache: null })
  await writeFile(join(userData, "desktop-pet.json"), saved)
  await host.init(); await flush()
  const pet = MockWindow.windows[0]
  assert.equal(pet.bounds.x, position.x)
  pet.emit("moved") // Exercise a pending drag-save timer during monitor removal.
  displays = [{ workArea: area }]
  screen.emit("display-removed")
  assert.ok(pet.bounds.x >= 0)
  assert.deepEqual(host.state().preferences.position, position)
  assert.deepEqual(JSON.parse(await readFile(join(userData, "desktop-pet.json"), "utf8")).preferences.position, position)
  displays = [{ workArea: area }, { workArea: second }]
  screen.emit("display-added")
  assert.deepEqual({ x: pet.bounds.x, y: pet.bounds.y }, position)
  host.dispose()
  assert.equal(screen.listenerCount("display-added"), 0)
  assert.deepEqual(JSON.parse(await readFile(join(userData, "desktop-pet.json"), "utf8")).preferences.position, position)
})

test("pet drag and native DPI drift keep canonical size and locks across moves, scales and displays", async t => {
  const { host, setCursor, screen } = await fixture(t)
  await host.init(); await flush()
  const pet = MockWindow.windows[0], origin = pet.getBounds()
  assert.deepEqual([pet.options.minWidth, pet.options.maxWidth, pet.options.minHeight, pet.options.maxHeight], [48, 48, 52, 52])
  let expected = [48, 52], boundsCalls = 0
  const setBounds = pet.setBounds.bind(pet)
  pet.setBounds = target => {
    boundsCalls++
    assert.deepEqual([target.width, target.height], expected)
    assert.deepEqual(pet.minimumSize, expected)
    assert.deepEqual(pet.maximumSize, expected)
    setBounds(target) // Synchronous moved events also exercise the recursion guard.
  }
  const pointer = (phase: string) => pet.webContents.emit("ipc-message", { senderFrame: pet.webContents.mainFrame }, "ame:pet-pointer", phase)
  pointer("down")
  for (let i = 1; i <= 100; i++) {
    setCursor(100 + i * 5 + 0.25, 100 - i * 3 + 0.75); pointer("move")
    assert.deepEqual(pet.getBounds(), { x: Math.round(origin.x + i * 5 + 0.25), y: Math.round(origin.y - i * 3 + 0.75), width: 48, height: 52 })
    for (const event of ["moved", "resized"]) {
      const before = pet.getBounds(), calls = boundsCalls
      pet.bounds = { ...before, width: before.width + 1, height: before.height + 2 }
      pet.emit(event)
      assert.deepEqual(pet.getBounds(), before)
      assert.equal(boundsCalls, calls + 1)
    }
  }
  pointer("up")
  assert.equal(pet.positionCalls, 0)
  assert.ok(pet.sizeLocks.length > 0)
  assert.ok(pet.sizeLocks.every(lock => lock.size[0] === 48 && lock.size[1] === 52))
  for (const scale of [0.5, 1, 0.25]) {
    expected = [Math.round(192 * scale), Math.round(208 * scale)]
    await host.configure({ scale })
    assert.deepEqual([pet.bounds.width, pet.bounds.height], expected)
    pet.bounds.width++; pet.bounds.height++
    screen.emit("display-metrics-changed")
    assert.deepEqual([pet.bounds.width, pet.bounds.height], expected)
    assert.deepEqual(pet.minimumSize, expected); assert.deepEqual(pet.maximumSize, expected)
  }
})

test("sprite fits both viewport dimensions without stretching its aspect ratio", () => {
  assert.match(petSpriteCss, /width:min\(100%,calc\(100vh \* 192 \/ 208\)\)/)
  assert.match(petSpriteCss, /height:auto;aspect-ratio:192 \/ 208;max-width:100%;max-height:100%;margin:auto/)
  assert.ok(petHtml().includes(petSpriteCss))
})

test("completion outcome arriving after idle triggers exactly once", () => {
  const activity = new PetActivity()
  activity.report('main', [session({ busy: 100, thinking: true })], 100)
  assert.equal(activity.report('main', [session({ busy: 100, running: false, idle: 200 })], 200), 'idle')
  assert.equal(activity.report('main', [session({ busy: 100, running: false, idle: 200, outcome: 'succeeded' })], 201), 'wave')
  assert.equal(activity.report('main', [session({ busy: 100, running: false, idle: 200, outcome: 'succeeded' })], 4000), 'idle')
})

test("pet rejects long presses, cancelled gestures, untrusted IPC and stale windows", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 })
  let activations = 0
  const { host, setMain } = await fixture(t, { defaultEnabled: true, onActivate: () => { activations++ } })
  await host.init(); await flush()
  const pet = MockWindow.windows[0]
  const pointer = (phase: string, frame = pet.webContents.mainFrame, channel = "ame:pet-pointer", ...extra: unknown[]) =>
    pet.webContents.emit("ipc-message", { senderFrame: frame }, channel, phase, ...extra)
  pointer("up")
  pointer("down"); t.mock.timers.tick(501); pointer("up")
  pointer("down"); pointer("cancel"); pointer("up")
  pointer("down", {}); pointer("up")
  pointer("down", pet.webContents.mainFrame, "ame:call"); pointer("up")
  pointer("down", pet.webContents.mainFrame, "ame:pet-pointer", "extra"); pointer("up")
  pointer("invalid"); pointer("up")
  assert.equal(activations, 0)
  setMain(false); pointer("down"); pointer("up"); assert.equal(activations, 0)
  setMain(true)
  await host.configure({ enabled: false }); await host.configure({ enabled: true }); await flush()
  pointer("down"); pointer("up"); assert.equal(activations, 0)
})

test("gesture threshold is sticky and reveal safely ignores missing or destroyed windows", () => {
  const gesture = new PetInteraction(), origin = { x: -500, y: 30 }
  gesture.update("down", { x: 0, y: 0 }, origin, 0)
  assert.deepEqual(gesture.update("move", { x: 3, y: 4 }, origin, 1), { position: { x: -497, y: 34 } })
  assert.deepEqual(gesture.update("up", { x: 0, y: 0 }, origin, 2), { position: origin })
  assert.deepEqual(gesture.update("up", origin, origin, 3), {})
  revealPetMainWindow(undefined)
  revealPetMainWindow({ isDestroyed: () => true, isMinimized() { throw new Error("destroyed") },
    restore() { assert.fail() }, show() { assert.fail() }, focus() { assert.fail() } })
})

test("sandbox pet preload captures only trusted primary gestures without exposing a page API", async () => {
  const source = await readFile(new URL("../../../apps/desktop/src/preload/pet.ts", import.meta.url), "utf8")
  const listeners = new Map<string, (event: any) => void>(), sent: unknown[][] = [], captured: number[] = []
  let loaded!: () => void
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: {}, require: (name: string) => {
      assert.equal(name, "electron")
      return { ipcRenderer: { send: (...args: unknown[]) => sent.push(args) } }
    },
    window: { addEventListener: (name: string, listener: () => void) => { assert.equal(name, "DOMContentLoaded"); loaded = listener } },
    document: { body: { addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
      setPointerCapture: (id: number) => captured.push(id) } },
  })
  loaded()
  const emit = (name: string, extra = {}) => listeners.get(name)!({ isTrusted: true, isPrimary: true, button: 0, pointerId: 7, ...extra })
  emit("pointerdown", { isTrusted: false }); emit("pointerdown", { button: 2 }); emit("pointerdown", { isPrimary: false })
  assert.deepEqual(sent, [])
  emit("pointerdown"); emit("pointermove", { pointerId: 8 }); emit("pointermove"); emit("pointerup"); emit("lostpointercapture")
  assert.deepEqual(captured, [7])
  assert.deepEqual(sent.splice(0), [["ame:pet-pointer", "down"], ["ame:pet-pointer", "move"], ["ame:pet-pointer", "up"]])
  emit("pointerdown"); emit("pointercancel"); emit("pointerup")
  emit("pointerdown"); emit("lostpointercapture"); emit("pointerup")
  assert.deepEqual(sent, [["ame:pet-pointer", "down"], ["ame:pet-pointer", "cancel"], ["ame:pet-pointer", "down"], ["ame:pet-pointer", "cancel"]])
  assert.doesNotMatch(petHtml(), /app-region:drag|<script/)
})

test("host defaults on; lifecycle, secure windows, speech, displays and drag persistence", async t => {
  let notifications = 0
  const { host, userData, screen, setMain } = await fixture(t, { onStateChanged: () => { notifications++ } })
  assert.deepEqual(defaultPetPreferences, { enabled: true, scale: 0.25, position: null })
  assert.equal((await host.init()).preferences.enabled, true); assert.equal(MockWindow.windows.length, 1)
  await flush()
  const pet = MockWindow.windows[0]
  assert.equal(pet.shown, true); assert.equal(pet.options.transparent, true)
  for (const key of ["frame", "hasShadow", "focusable", "resizable"]) assert.equal(pet.options[key], false)
  for (const key of ["alwaysOnTop", "skipTaskbar"]) assert.equal(pet.options[key], true)
  assert.deepEqual(pet.openHandler?.(), { action: "deny" })
  assert.equal(pet.options.webPreferences.sandbox, true); assert.equal(pet.options.webPreferences.nodeIntegration, false); assert.equal(pet.options.webPreferences.contextIsolation, true)
  let prevented = false; pet.webContents.emit("will-navigate", { preventDefault() { prevented = true } }); assert.ok(prevented)
  assert.ok(pet.url.length < 10000)
  host.testSpeech(); await flush()
  const bubble = MockWindow.windows[1]
  assert.ok(bubble.shown); assert.ok(bubble.ignoreMouse); assert.equal(bubble.bounds.height, 92)
  host.theme({ ...defaultPetPalette, background: "#fff" }); await flush()
  assert.ok(bubble.scripts.some(script => script.includes("#fff")))
  host.testSpeech(); await flush()
  assert.equal(pet.scripts.filter(script => script.includes("bell.play()")).length, 1)
  await host.speech({ enabled: false }); assert.ok(MockWindow.windows[2].destroyed)
  pet.bounds = { ...pet.bounds, x: 300, y: 200 }; pet.emit("moved")
  await new Promise(resolve => setTimeout(resolve, 430))
  assert.deepEqual(JSON.parse(await readFile(join(userData, "desktop-pet.json"), "utf8")).preferences.position, { x: 300, y: 200 })
  await host.configure({ scale: 1 }); assert.equal(pet.bounds.width, 192)
  await host.configure({ resetPosition: true }); assert.equal(pet.bounds.x, 984)
  pet.bounds.x = 5000; pet.emit("moved"); await host.configure({ scale: 1 })
  screen.emit("display-removed"); assert.ok(pet.bounds.x < area.width)
  assert.equal(host.report("one", [session({ thinking: true })]), "thinking")
  assert.equal(host.removeWindow("one"), "idle")
  setMain(false); host.reconcile(); assert.ok(pet.destroyed)
  setMain(true); host.reconcile(); await flush(); assert.equal(MockWindow.windows.length, 4)
  await host.configure({ enabled: false }); assert.ok(MockWindow.windows[3].destroyed)
  assert.ok(notifications > 0)
  host.dispose(); host.dispose()
  assert.equal(screen.listenerCount("display-removed"), 0); assert.equal(screen.listenerCount("display-metrics-changed"), 0)
  await assert.rejects(host.configure({ enabled: true }), /PET_HOST_DISPOSED/)
  assert.deepEqual(await readdir(userData), ["desktop-pet.json"])
})

test("bubble measures, auto-hides after eight seconds and a pending drag is flushed on dispose", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000000 })
  const { host, userData, screen } = await fixture(t, { defaultEnabled: true })
  await host.init(); await flush()
  t.mock.timers.tick(200); await flush()
  const pet = MockWindow.windows[0], bubble = MockWindow.windows[1]
  assert.ok(bubble.shown)
  t.mock.timers.tick(7999); await flush(); assert.equal(bubble.destroyed, false)
  t.mock.timers.tick(201); await flush(); assert.equal(bubble.destroyed, true)
  pet.bounds = { ...pet.bounds, x: 100, y: 120 }; pet.emit("moved")
  host.dispose()
  assert.deepEqual(JSON.parse(await readFile(join(userData, "desktop-pet.json"), "utf8")).preferences.position, { x: 100, y: 120 })
  assert.ok(pet.destroyed); assert.equal(screen.listenerCount("display-removed"), 0)
})

test("host reports persistence failure without leaving temporary files", async t => {
  const { host, userData } = await fixture(t)
  await host.init()
  await rm(userData, { recursive: true }); await writeFile(userData, "not a directory")
  await assert.rejects(host.configure({ scale: 0.5 }))
  assert.match(host.state().error, /Không thể lưu/)
})

test("host recovers corrupt JSON/schema and persists preferences across restarts", async t => {
  for (const content of ["{", JSON.stringify({ preferences: { enabled: "yes" } }), JSON.stringify({ preferences: { enabled: true, scale: 2, position: null }, speech: { enabled: false, sound: false }, cache: { model: "m", generatedAt: 1, json: "{}" } })]) {
    const { host, userData } = await fixture(t)
    await writeFile(join(userData, "desktop-pet.json"), content)
    assert.deepEqual((await host.init()).preferences, defaultPetPreferences)
    await host.configure({ enabled: true, scale: 0.5 }); host.dispose()
    const next = createPetHost({ userData, sprite, electron: { BrowserWindow: MockWindow, screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [{ workArea: area }], getPrimaryDisplay: () => ({ workArea: area }) }) } as unknown as PetHostOptions["electron"], hasMainWindow: () => false })
    t.after(() => next.dispose())
    assert.equal((await next.init()).preferences.scale, 0.5)
    assert.equal(next.state().preferences.enabled, true)
    const snapshot = next.state(); snapshot.preferences.scale = 2
    assert.equal(next.state().preferences.scale, 0.5)
    next.dispose()
  }
})

test("explicit defaultEnabled false stays off until enabled", async t => {
  const { host } = await fixture(t, { defaultEnabled: false })
  assert.equal((await host.init()).preferences.enabled, false)
  assert.equal(MockWindow.windows.length, 0)
  await host.configure({ enabled: true }); await flush()
  assert.equal(MockWindow.windows.length, 1)
})

test("saved disabled preference overrides the new enabled default", async t => {
  const { host, userData } = await fixture(t, { defaultEnabled: true })
  await writeFile(join(userData, "desktop-pet.json"), JSON.stringify({ preferences: { enabled: false, scale: 0.5, position: { x: 20, y: 30 } }, speech: { enabled: true, sound: false }, cache: null }))
  assert.deepEqual((await host.init()).preferences, { enabled: false, scale: 0.5, position: { x: 20, y: 30 } })
  assert.equal(MockWindow.windows.length, 0)
})

test("default enabled pet waits for a main window", async t => {
  const { host, setMain } = await fixture(t)
  setMain(false)
  assert.equal((await host.init()).preferences.enabled, true)
  assert.equal(MockWindow.windows.length, 0)
  setMain(true); host.reconcile(); await flush()
  assert.equal(MockWindow.windows.length, 1)
  assert.equal(MockWindow.windows[0].shown, true)
})

test("host handles renderer crashes and explicit defaultEnabled", async t => {
  const { host } = await fixture(t, { defaultEnabled: true })
  assert.equal((await host.init()).preferences.enabled, true); await flush()
  const pet = MockWindow.windows[0]
  pet.webContents.emit("render-process-gone", {}, { reason: "crashed" })
  assert.ok(pet.destroyed); assert.ok(host.state().error)
  await host.configure({ enabled: true }); await flush()
  assert.equal(host.state().error, ""); assert.equal(MockWindow.windows.length, 2)
})

test("host caches validated generation, rejects concurrent requests and cancels on dispose", async t => {
  let release!: (value: typeof localDialogue) => void, signal!: AbortSignal
  const { host, userData } = await fixture(t, { generateDialogue: async (_model, input) => { signal = input; return new Promise(resolve => { release = resolve }) } })
  await host.init()
  const request = host.generate("model-a")
  assert.ok(host.state().generating)
  await assert.rejects(host.generate("model-b"), /PET_GENERATION_BUSY/)
  release(localDialogue); assert.equal((await request).dialogueModel, "model-a")
  const stored = JSON.parse(await readFile(join(userData, "desktop-pet.json"), "utf8"))
  assert.deepEqual(parseDialogue(JSON.parse(stored.cache.json)), localDialogue)
  const invalid = host.generate("model-b"); release({ ...localDialogue, idle: ["<bad>", "b"] })
  await assert.rejects(invalid, /PET_GENERATION_FAILED/); assert.equal(host.state().dialogueModel, "model-a")
  const aborted = host.generate("model-c"); host.dispose(); assert.ok(signal.aborted); release(localDialogue)
  await assert.rejects(aborted, /PET_GENERATION_FAILED/)
  assert.equal(JSON.parse(await readFile(join(userData, "desktop-pet.json"), "utf8")).cache.model, "model-a")
})

test("dialogue generation sends only static prompt and enforces response/policy limits", async () => {
  const api = { account: { role: "user" }, guard: async () => {}, provider: { provider: { base_url: "https://example.com/v1", api_key: "test-only" }, catalog: { version: "1", default_model: "allowed", small_model: "allowed", models: [{ id: "allowed", name: "Allowed", tool_call: true, vision: false, context: 1000, output: 1000 }] } } } as unknown as AmeApi
  let calls = 0
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, "https://example.com/v1/chat/completions")
    assert.deepEqual(JSON.parse(String(init?.body)).messages, [{ role: "user", content: dialoguePrompt }])
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(localDialogue) } }] }))
  }
  assert.deepEqual(await generatePetDialogue(api, "allowed", new AbortController().signal, fetcher), localDialogue)
  await assert.rejects(generatePetDialogue(api, "other", new AbortController().signal, fetcher), /AMECODE_MODEL_NOT_ALLOWED/)
  assert.equal(calls, 1)
  await assert.rejects(generatePetDialogue(api, "allowed", new AbortController().signal, async () => new Response("x".repeat(65537))), /PET_RESPONSE_TOO_LARGE/)
  await assert.rejects(generatePetDialogue(api, "allowed", new AbortController().signal, async () => new Response("", { status: 500 })), /PET_PROVIDER_ERROR/)
  await assert.rejects(generatePetDialogue(undefined, "allowed", new AbortController().signal, fetcher), /AMECODE_LOGIN_REQUIRED/)
})
