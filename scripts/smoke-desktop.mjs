import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { OpenCode } from '@opencode/client'
import { create as createTunnel, OpenTunnelStorage } from '@opentunnel/client'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import electron from 'electron'

const root = await mkdtemp(path.join(os.tmpdir(), 'ame-ide-smoke-'))
const project = path.join(root, 'project'), userData = path.join(root, 'data')
await mkdir(project); await mkdir(userData)
await writeFile(path.join(project, 'hello.ts'), 'export const greeting = "hello"\n')
await writeFile(path.join(project, 'second.ts'), 'export const second = 2\n')
execFileSync('git', ['init', '--quiet', project])
execFileSync('git', ['add', '.'], { cwd: project })
execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', '-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'Local fixture'], { cwd: project })
await writeFile(path.join(userData, 'projects.json'), JSON.stringify([{ id: 'smoke', directory: project }]))
const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port; await new Promise(resolve => server.close(resolve))
await writeFile(path.join(userData, 'pairing.json'), JSON.stringify({ enabled: true, keepScreenActive: false }))
let pairingPort, pairingURL
const env = { ...process.env, AME_IDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.AME_IDE_PACKAGED_EXECUTABLE
const child = spawn(packaged || electron, [...(packaged ? [] : ['.']), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''; child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data)
let socket; const pending = new Map(); let sequence = 0; const errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function command(method, params = {}) {
  const id = ++sequence
  const result = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP_TIMEOUT: ${method}`)) }, 15000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject }) })
  socket.send(JSON.stringify({ id, method, params })); return result
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    try { if (await evaluate(expression)) return }
    catch (error) { if (!String(error).includes('Inspected target navigated or closed')) throw error }
    await sleep(100)
  }
  const state = await evaluate('JSON.stringify({ tabs: document.querySelector(".editor-tabs")?.textContent, editor: document.querySelector(".monaco-editor")?.textContent, alerts: [...document.querySelectorAll("[role=alert]")].map(node => node.textContent) })')
  throw new Error('UI_TIMEOUT: ' + expression + '\n' + state)
}
try {
  let target
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Electron exited early: ' + logs)
    try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = targets.find(t => t.type === 'page' && t.url.startsWith('file:')); if (target) break } catch {}
    await sleep(100)
  }
  assert.ok(target, 'Electron renderer was not responsive\n' + logs)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data)
    if (data.id) { const p = pending.get(data.id); pending.delete(data.id); if (data.error) p?.reject(new Error(JSON.stringify(data.error))); else p?.resolve(data.result) }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text + ': ' + JSON.stringify(data.params.exceptionDetails.exception))
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(data.params.entry.text)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable'); await command('Log.enable')
  await until('Boolean(window.ame && document.querySelector("[data-testid=shell]"))')
  assert.equal(await evaluate('typeof window.require'), 'undefined')
  assert.equal(await evaluate('typeof window.process'), 'undefined')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=inspector]"))'), false, 'Explorer is hidden on a fresh profile')
  await evaluate('document.querySelector(\'button[aria-label="Project Inspector (Ctrl+Shift+E)"]\').click()')
  await until('Boolean(document.querySelector("[data-testid=inspector]"))')
  await until('(async()=> (await window.ame.connection()).connected)()')
  const backend = await evaluate('window.ame.connection()')
  assert.equal(backend.version, '2.3.2')
  assert.equal((await fetch(`${backend.url}/api/info`)).status, 401, 'Bundled backend requires private authentication')
  const created = await evaluate('window.ame.createSession("smoke")')
  assert.ok(created.id)
  assert.deepEqual(await evaluate('window.ame.models("smoke")'), [], 'Signed-out policy must hide models')
  const retried = await evaluate('window.ame.startBackend()')
  assert.equal(retried.url, backend.url, 'Retry while healthy must not spawn a duplicate backend')
  assert.equal(await evaluate('(async()=> (await window.ame.projects())[0].id)()'), 'smoke')
  await until('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("hello.ts"))')
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("hello.ts")).click()')
  await until('Boolean(document.querySelector(".monaco-editor"))')
  await until('document.querySelector(".monaco-editor")?.textContent.includes("greeting")')
  const editorPoint = await evaluate('(()=>{const r=document.querySelector(".monaco-editor .view-lines").getBoundingClientRect();return {x:r.x+50,y:r.y+12}})()')
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...editorPoint, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...editorPoint, button: 'left', clickCount: 1 })
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 })
  await command('Input.insertText', { text: '// typed in Monaco\n' })
  await until('document.querySelector(".statusbar").textContent.includes("1 tệp chưa lưu")')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: process.platform === 'darwin' ? 4 : 2 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 })
  await until('document.querySelector(".statusbar").textContent.includes("Đã lưu")')
  assert.match(await readFile(path.join(project, 'hello.ts'), 'utf8'), /typed in Monaco/)
    await command('Input.insertText', { text: '// hidden-save-guard\n' })
    await until('document.querySelector(".statusbar").textContent.includes("1 tệp chưa lưu")')
    const savedText = await readFile(path.join(project, 'hello.ts'), 'utf8')
    await evaluate('[...document.querySelectorAll(".side-panel__tab-list button")].find(b=>b.textContent==="Git Diff").click()')
    await evaluate('[...document.querySelectorAll(".inspector-mode-btn")].find(b=>b.title==="Git Diff").click()')
    await until('Boolean(document.querySelector(\'.scm-file-row button[data-git-group="working"][data-git-path="hello.ts"]\'))')
    await evaluate('document.querySelector(\'.scm-file-row button[data-git-group="working"][data-git-path="hello.ts"]\').click()')
    await until('Boolean(document.querySelector(".monaco-diff-editor"))')
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"s",ctrlKey:true,bubbles:true}))')
    await sleep(200)
    assert.equal(await readFile(path.join(project, 'hello.ts'), 'utf8'), savedText, 'Ctrl+S in Diff must not save a hidden file buffer')
    await evaluate('[...document.querySelectorAll(".side-panel__tab-list button")].find(b=>b.textContent==="Code").click()')
    await until('document.querySelector(".editor-tab.selected button").title === "hello.ts"')
    await evaluate('[...document.querySelectorAll(".inspector-mode-btn")].find(b=>b.title==="Explorer").click()')
    await until('[...document.querySelectorAll(".tree-row")].some(b=>b.title==="second.ts")')
    await evaluate('[...document.querySelectorAll(".tree-row")].find(b=>b.title==="second.ts").click()')
    await until('document.querySelector(".editor-tab.selected button").title === "second.ts"')
    assert.ok(await evaluate(`document.querySelector('.editor-tab:not(.selected) button[title="hello.ts"]').textContent.includes('●')`), 'Inactive unsaved file retains its dirty marker')
    assert.equal(await evaluate(`document.querySelector('.editor-tab.selected button').textContent.includes('●')`), false, 'Clean active file has no dirty marker')
    await evaluate('[...document.querySelectorAll(".editor-tab button")].find(b=>b.getAttribute("aria-label")==="Đóng second.ts").click()')
    await until('document.querySelector(".editor-tab.selected button").title === "hello.ts"')
    await evaluate('document.querySelector(".editor-toolbar button").click()')
    await until('document.querySelector(".statusbar").textContent.includes("Đã lưu")')
    assert.match(await readFile(path.join(project, 'hello.ts'), 'utf8'), /hidden-save-guard/)
    // Pair a scoped test client through the same native gateway to seed genuine parentID sessions.
    for (let i = 0; i < 210; i++) {
      const status = await evaluate('window.ame.pairingStatus()')
      if (status.error) throw new Error(status.error)
      if (status.enabled && !status.connecting && status.publicURL) { pairingPort = status.port; pairingURL = status.publicURL; break }
      await sleep(1000)
    }
    assert.ok(pairingURL, 'Automatic encrypted tunnel must become ready')
    const pair = await evaluate('window.ame.pairingCode()')
    const code = new URL(pair.url).pathname.split('/').at(-1)
    const tokenResponse = await fetch(`http://127.0.0.1:${pairingPort}/auth/connect/${code}`, { headers: { accept: 'application/json' } })
    assert.equal(tokenResponse.status, 200)
    const device = await tokenResponse.json()
    const native = OpenCode.make({ baseUrl: backend.url, headers: { authorization: `Basic ${Buffer.from(`opencode:${device.token}`).toString('base64')}` } })
    let parentID = created.id
    const children = []
    for (let depth = 1; depth <= 3; depth++) {
      const session = await native.session.create({ parentID, title: `Smoke native depth ${depth}`, location: { directory: project } })
      children.push(session); parentID = session.id
    }
    await evaluate('document.querySelector("[data-chat-drawer=agents]").click()')
    await until('document.querySelectorAll("[role=treeitem]").length === 4')
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[role=treeitem]")].map(e=>Number(e.getAttribute("aria-level")))'), [1, 2, 3, 4])
    await evaluate(`document.querySelector('[data-session-id="${children[2].id}"]').click()`)
    await until('document.querySelector(".chat-title-text").textContent === "Smoke native depth 3"')
    await evaluate('[...document.querySelectorAll(".side-panel__tab-list button")].find(b=>b.textContent==="Code").click()')
    await until('document.querySelector(".editor-tab.selected button").title === "hello.ts"')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:",",ctrlKey:true,bubbles:true}))')
  await until('Boolean(document.querySelector(".settings-content"))')
  await evaluate('(()=>{const s=[...document.querySelectorAll(".settings-content select")].find(s=>s.querySelector("option[value=light]"));s.value="light";s.dispatchEvent(new Event("change",{bubbles:true}))})()')
  await until('document.documentElement.dataset.theme === "light"')
  await evaluate('document.querySelector(".modal header button").click()')
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const surfaces = await evaluate(`['.titlebar','.sidebar','.inspector-pane','.chat-pane','.side-panel','.composer-card','.composer-toolbar','.editor-terminal','.side-panel__status'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {selector,x:r.x,y:r.y,w:r.width,h:r.height}})`)
  assert.deepEqual(surfaces.slice(1, 5).map(r => [Math.round(r.x), Math.round(r.w)]), [[0, 256], [263, 240], [510, 435], [952, 480]], 'Four-pane geometry matches the supplied HTML at 1440px')
  assert.deepEqual(surfaces.map(r => Math.round(r.h)), [40, 852, 852, 852, 852, 103, 30, 185, 26], 'Header, composer, terminal and footer heights match the supplied HTML')
  await until('document.querySelector(".composer-context-strip .ctx-strip-chip")?.textContent.includes("0 files changed")')
  assert.deepEqual(await evaluate(`window.ame.sessionDiff("smoke", "${children[2].id}")`), [], 'Git working-tree edits do not belong to an empty session')
  await evaluate('document.querySelector(".composer-context-strip .ctx-strip-chip").click()')
  await until('document.querySelector(".panel-tab.is-active")?.textContent === "Session Changes"')
  await evaluate('[...document.querySelectorAll(".side-panel__tab-list button")].find(b=>b.textContent==="Code").click()')
  if (process.env.AME_IDE_SMOKE_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(process.env.AME_IDE_SMOKE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  }
  const layout = await evaluate(`(()=>{const w=document.querySelector('.workspace-body');const c=document.querySelector('[data-testid=chat]').getBoundingClientRect();const p=document.querySelector('[data-testid=side-panel]').getBoundingClientRect();return {panes:[...w.children].filter(e=>e.matches('aside,main,section')).length,order:[...w.children].filter(e=>e.matches('aside,main,section')).map(e=>e.dataset.testid),chatWidth:c.width,panelLeft:p.left,chatRight:c.right,overflow:w.scrollWidth>w.clientWidth,header:document.querySelector('.chat-pane__header').getBoundingClientRect().height}})()`)
  assert.equal(layout.panes, 4, 'Reference shell has four independent main surfaces')
  assert.deepEqual(layout.order, ['projects', 'inspector', 'chat', 'side-panel'])
  assert.equal(layout.header, 42)
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-title-group")).overflow'), 'visible', 'Blue activity indicator and pulse must not be clipped by the title group')
  assert.equal(await evaluate('document.querySelector(\'button[aria-label="Đóng Inspector (ẩn cố định)"] path\').getAttribute("d")'), 'm15 18-6-6 6-6', 'Inspector hide arrow points left')
  assert.equal(layout.overflow, false)
  assert.ok(layout.panelLeft >= layout.chatRight)
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".pane-resizer")].map(e=>e.dataset.resize)'), ['sidebar','inspector','sidepanel'])
  await evaluate('document.querySelector(".pane-resizer[data-resize=inspector]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))')
  await until('document.querySelector(".pane-resizer[data-resize=inspector]").getAttribute("aria-valuenow")==="260"')
  await evaluate('document.querySelector(".pane-resizer[data-resize=inspector]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
  await until('document.querySelector(".pane-resizer[data-resize=inspector]").getAttribute("aria-valuenow")==="240"')
  await evaluate('(()=>{const input=document.querySelector(".proj-search-box input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"no-matching-project");input.dispatchEvent(new Event("input",{bubbles:true}))})()')
  await until('document.querySelectorAll(".proj-group").length===0')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"e",ctrlKey:true,shiftKey:true,bubbles:true}))')
  await until('!document.querySelector("[data-testid=inspector]")')
  await evaluate('window.__smokeBeforeReload = true')
  await command('Page.reload')
  await until('!window.__smokeBeforeReload && Boolean(window.ame && document.querySelector("[data-testid=chat]"))')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=inspector]"))'), false, 'Inspector hidden state must survive reload')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"f",ctrlKey:true,shiftKey:true,bubbles:true}))')
  await until('Boolean(document.querySelector("[data-testid=project-search]"))')
  await evaluate('(()=>{const input=document.querySelector(".vsc-search-field input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"greeting");input.dispatchEvent(new Event("input",{bubbles:true}))})()')
  await until('Boolean(document.querySelector(".vsc-search-hit")?.title?.startsWith("hello.ts:1:"))')
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate('document.querySelector(".workspace-body").scrollWidth > document.querySelector(".workspace-body").clientWidth'), false)
  await evaluate('document.querySelector("[data-chat-drawer=artifacts]").click()')
  await until('document.querySelector("[data-testid=chat-drawer]").classList.contains("is-open")')
  const corner = await evaluate('(()=>{const c=document.querySelector(".chat-pane").getBoundingClientRect(),d=document.querySelector("[data-testid=chat-drawer]").getBoundingClientRect();return d.left>=c.left && d.right<=c.right && d.top>=c.top})()')
  assert.equal(corner, true, 'Drawer stays inside Chat, independent of File Stage')
  await command('Emulation.clearDeviceMetricsOverride')
  await evaluate('document.querySelector(".stage-actions button").click()')
  await until('!document.querySelector(".editor-terminal") || getComputedStyle(document.querySelector(".editor-terminal")).display === "none"')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"b",ctrlKey:true,altKey:true,bubbles:true}))')
  await until('!document.querySelector("[data-testid=side-panel]")')
  await evaluate('window.__smokeBeforeReload = true')
  await command('Page.reload')
  await until('!window.__smokeBeforeReload && Boolean(window.ame && document.querySelector("[data-testid=chat]"))')
  await until('document.documentElement.dataset.theme === "light"')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=side-panel]"))'), false)
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"b",ctrlKey:true,altKey:true,bubbles:true}))')
  await until('Boolean(document.querySelector(".monaco-editor"))')
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:",",ctrlKey:true,bubbles:true}))')
  await until('Boolean(document.querySelector(".settings-navigation"))')
  await evaluate('[...document.querySelectorAll(".settings-navigation button")].find(b=>b.textContent==="AmeKit").click()')
  await until('Boolean(document.querySelector(".amekit-core input[autocomplete=username]"))')
  assert.equal(await evaluate('document.querySelectorAll("[role=dialog]").length'), 1, 'AmeKit is embedded in native Settings, not a nested extension dialog')
  await evaluate('[...document.querySelectorAll(".settings-navigation button")].find(b=>b.textContent==="Pairing").click()')
  await until('Boolean(document.querySelector(".pairing-settings"))')
  await until('(async()=> (await window.ame.pairingStatus()).enabled)()')
  await evaluate('[...document.querySelectorAll(".pairing-settings button")].find(b=>b.textContent==="Pair device").click()')
  await until('Boolean(document.querySelector(".pairing-code img"))')
  assert.equal(await evaluate('document.querySelectorAll(".pairing-settings input").length'), 0, 'No manual tunnel URL or port')
  assert.equal(await evaluate('document.querySelectorAll(".pairing-settings [role=switch]").length'), 2)
  const originalQR = await evaluate('document.querySelector(".pairing-code img").src')
  await evaluate('[...document.querySelectorAll(".pairing-dialog button")].find(b=>b.textContent==="Refresh code").click()')
  await until(`Boolean(document.querySelector('.pairing-code img')) && document.querySelector('.pairing-code img').src !== ${JSON.stringify(originalQR)}`)
  await evaluate('[...document.querySelectorAll(".pairing-dialog button")].find(b=>b.textContent==="Copy link").click()')
  await until('[...document.querySelectorAll(".pairing-dialog button")].some(b=>b.textContent==="Copied")')
  const pairingLink = await evaluate('navigator.clipboard.readText()')
  assert.equal(new URL(pairingLink).origin, pairingURL)
  assert.equal((await fetch(`${pairingURL}/api/info`, { signal: AbortSignal.timeout(20000) })).status, 401)
  const pairingResponse = await fetch(pairingLink, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  assert.equal(pairingResponse.status, 200)
  const paired = await pairingResponse.json()
  const pairedAuth = { authorization: `Basic ${Buffer.from(`opencode:${paired.token}`).toString('base64')}` }
  assert.equal((await fetch(`${pairingURL}/api/info`, { headers: pairedAuth, signal: AbortSignal.timeout(20000) })).status, 200)
  assert.equal((await fetch(pairingLink, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) })).status, 401)
  if (process.env.AME_IDE_PAIRING_SCREENSHOT) {
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.AME_IDE_PAIRING_SCREENSHOT, Buffer.from(shot.data, 'base64'))
  }
  await evaluate(`document.querySelector('button[aria-label="Close pairing"]').click()`)
  await evaluate(`document.querySelector('button[aria-label="Remote access"]').click()`)
  await until('(async()=> !(await window.ame.pairingStatus()).enabled)()')
  await assert.rejects(fetch(`http://127.0.0.1:${pairingPort}/api/info`, { signal: AbortSignal.timeout(2000) }))
  assert.equal(JSON.parse(await readFile(path.join(userData, 'pairing.json'), 'utf8')).enabled, false)
  await evaluate('[...document.querySelectorAll(".settings-navigation button")].find(b=>b.textContent.startsWith("Giao")).click()')
  await evaluate('[...document.querySelectorAll(".setting-row button")].find(b=>b.textContent==="nord").click()')
  await evaluate('[...document.querySelectorAll(".setting-row button")].find(b=>b.textContent==="Wide").click()')
  await evaluate('[...document.querySelectorAll(".setting-row button")].find(b=>b.textContent==="Knowledge Work").click()')
  await evaluate('document.querySelector(".modal header button").click()')
  await evaluate('window.__smokeBeforeReload = true')
  await command('Page.reload')
  await until('!window.__smokeBeforeReload && document.documentElement.dataset.workspaceTint === "nord" && document.documentElement.dataset.layoutMode === "knowledge" && getComputedStyle(document.documentElement).getPropertyValue("--chat-max-w") === "960px"')
  assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--chat-max-w")'), '960px')
  assert.equal(await evaluate('[...document.querySelectorAll(".side-panel__tab-list button")].some(b=>b.textContent==="Terminal")'), false)
  const apiResult = await evaluate(`(async()=>{const d=await window.ame.read('smoke','hello.ts');await window.ame.save('smoke','hello.ts',d.content+'// persisted\\n',d.revision);try{await window.ame.save('smoke','hello.ts','stale',d.revision);return false}catch(e){return String(e).includes('FILE_CONFLICT')}})()`)
  assert.equal(apiResult, true, 'Revision conflict must survive IPC')
  assert.match(await readFile(path.join(project, 'hello.ts'), 'utf8'), /persisted/)
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=chat]"))'), true)
  assert.deepEqual(errors, [], 'Renderer or worker errors')
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  await evaluate('window.ame.window("close")')
  assert.equal(await Promise.race([exited, sleep(10000).then(() => 'timeout')]), 0, 'App must close cleanly without forced termination')
  await assert.rejects(fetch(`${backend.url}/api/info`, { signal: AbortSignal.timeout(2000) }), 'Owned backend must stop on app exit')
  console.log('PASS: automatic private backend, authentication, policy, session creation, idempotent retry, owned backend shutdown; production renderer, sandboxed preload IPC, project restore, Monaco typing/save shortcut, independent File/Diff selection and hidden-save guard, real four-level session tree/child chat selection, disk persistence/conflict, four-pane HTML layout, sticky Inspector, project search, corner drawer, independent bottom terminal, native AmeKit Settings, Android Pairing QR/link, one-time redemption and token auth through gateway, persisted remote disable, layout preference restore, chat shell, graceful shutdown')
} catch (error) { console.error(logs); throw error }
finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await evaluate('window.ame.window("close")') } catch {} socket.close() }
  if (child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]); if (child.exitCode === null) child.kill() }
  const cleanup = createTunnel({ api: 'https://opentunnel.xyz', store: OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: path.join(userData, 'remote-access') } }) })
  try { await cleanup.tunnel.remove() } finally { await cleanup.dispose() }
  await sleep(300); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
