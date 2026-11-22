import assert from "node:assert/strict"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultPetPreferences, loadPetSprite, PetActivity, petBounds, petHtml, petScale, type PetSession } from "../src/pet"
import { petBubbleBounds, petPalette, defaultPetPalette } from "../src/pet-appearance"
import { dialoguePrompt, localDialogue, parseDialogue, PetSpeech, petBubbleHtml } from "../src/pet-dialogue"
import { petChime } from "../src/pet-chime"
import { createPetHost, type PetHostOptions } from "../src/pet-host"
import { generatePetDialogue } from "../src/pet-generation"
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
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: (handler: () => { action: string }) => { this.openHandler = handler },
    executeJavaScript: async (code: string) => { this.scripts.push(code); return code.includes("getBoundingClientRect") ? 92 : undefined },
  })
  openHandler?: () => { action: string }
  constructor(readonly options: Record<string, any>) { super(); this.bounds = { ...this.bounds, ...Object.fromEntries(Object.entries(options).filter(([key]) => ["x", "y", "width", "height"].includes(key))) }; MockWindow.windows.push(this) }
  isDestroyed() { return this.destroyed }
  getBounds() { return { ...this.bounds } }
  setBounds(bounds: typeof this.bounds) { this.bounds = bounds; this.emit("moved") }
  async loadURL(url: string) { this.url = url }
  showInactive() { this.shown = true }
  setIgnoreMouseEvents(value: boolean) { this.ignoreMouse = value }
  destroy() { this.destroyed = true; this.emit("closed") }
}
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, extra: Partial<PetHostOptions> = {}) {
  const userData = await mkdtemp(join(tmpdir(), "ame-pet-"))
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [{ workArea: area }], getPrimaryDisplay: () => ({ workArea: area }) })
  MockWindow.windows = []
  let main = true
  const host = createPetHost({ userData, sprite, electron: { BrowserWindow: MockWindow, screen } as unknown as PetHostOptions["electron"], hasMainWindow: () => main, ...extra })
  t.after(async () => { host.dispose(); await rm(userData, { recursive: true, force: true }) })
  return { host, userData, screen, setMain(value: boolean) { main = value } }
}

test("host defaults off; lifecycle, secure windows, speech, displays and drag persistence", async t => {
  let notifications = 0
  const { host, userData, screen, setMain } = await fixture(t, { onStateChanged: () => { notifications++ } })
  assert.equal((await host.init()).preferences.enabled, false); assert.equal(MockWindow.windows.length, 0)
  await host.configure({ enabled: true }); await flush()
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
