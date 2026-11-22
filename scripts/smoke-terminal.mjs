import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import electron from 'electron'

const root = await mkdtemp(path.join(os.tmpdir(), 'ame-terminal-smoke-'))
const project = path.join(root, 'project with spaces'), userData = path.join(root, 'data')
await mkdir(project); await mkdir(userData)
await writeFile(path.join(userData, 'projects.json'), JSON.stringify([{ id: 'terminal-smoke', directory: project }]))
const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port; await new Promise(resolve => server.close(resolve))
const env = { ...process.env, AME_IDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.AME_IDE_PACKAGED_EXECUTABLE
const child = spawn(packaged || electron, [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', socket, sequence = 0
const errors = [], pending = new Map()
child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function command(method, params = {}) {
  const id = ++sequence
  const response = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP_TIMEOUT: ${method}`)) }, 15000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject }) })
  socket.send(JSON.stringify({ id, method, params })); return response
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  for (let index = 0; index < 150; index++) { if (await evaluate(expression)) return; await sleep(100) }
  throw new Error(`UI_TIMEOUT: ${expression}`)
}
async function enter(text) {
  await until('Boolean(document.querySelector(".terminal-surface textarea"))')
  await evaluate('document.querySelector(".terminal-surface textarea").focus()')
  await command('Input.insertText', { text })
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}
try {
  let target
  for (let index = 0; index < 150; index++) {
    if (child.exitCode !== null) throw new Error(`ELECTRON_EXIT: ${logs}`)
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')); if (target) break } catch {}
    await sleep(100)
  }
  assert.ok(target, logs)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data)
    if (data.id) { const request = pending.get(data.id); pending.delete(data.id); if (data.error) request?.reject(new Error(JSON.stringify(data.error))); else request?.resolve(data.result) }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails)
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(data.params.entry.text)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable'); await command('Log.enable')
  await until(`Boolean(window.ame && document.querySelector('button[aria-label="New Terminal"]:not(:disabled)'))`)
  assert.equal(await evaluate('typeof window.require'), 'undefined')
  assert.equal(await evaluate('(async()=> (await window.ame.terminalList("terminal-smoke")).length)()'), 0, 'Opening a project does not execute its shell profile automatically')
  await evaluate('document.querySelector("button[aria-label=\\"New Terminal\\"]").click()')
  await until('Boolean(document.querySelector(".terminal-surface textarea"))')
  const id = await evaluate('document.querySelector(".terminal-surface").dataset.terminalId')
  const snapshot = () => `window.ame.terminalSnapshot("terminal-smoke", ${JSON.stringify(id)})`
  await until(`(async()=> (await ${snapshot()}).output.length > 0)()`)
  await enter(`node -e "console.log('AME_' + 'TERMINAL_OK');console.log(process.cwd());console.log('\\x1b[31mRED_OK\\x1b[0m')"`)
  await until(`(async()=> (await ${snapshot()}).output.includes('AME_TERMINAL_OK'))()`)
  const output = await evaluate(`(async()=> (await ${snapshot()}).output)()`)
  assert.ok(output.includes(project), `Shell must start in selected project: ${output}`)
  assert.match(output, /\x1b\[[0-9;]*m/, 'Native terminal emits ANSI color sequences (ConPTY may normalize colors)')
  await until(`Array.from(document.querySelectorAll('.terminal-surface .xterm-rows span')).some(span => span.textContent.includes('RED_OK') && (span.classList.contains('xterm-fg-1') || span.classList.contains('xterm-fg-9') || /rgb\\(.*\\)/.test(span.style.color)))`)
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await until(`(async()=> (await ${snapshot()}).cols !== 80)()`)
  const before = await evaluate(`(async()=> (await ${snapshot()}).cols)()`)
  await evaluate('document.querySelector(".pane-resizer[data-resize=sidepanel]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))')
  await until(`(async()=> (await ${snapshot()}).cols !== ${before})()`)
  await enter(`node -e "console.log('LONG_'+'RUNNING');setInterval(()=>{},1000)"`)
  await until(`(async()=> (await ${snapshot()}).output.includes('LONG_RUNNING'))()`)
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 })
  await sleep(800)
  await enter(`node -e "console.log('AFTER_'+'INTERRUPT')"`)
  await until(`(async()=> (await ${snapshot()}).output.includes('AFTER_INTERRUPT'))()`)
  await evaluate('document.querySelector("button[aria-label=\\"Close Terminal Panel\\"]").click()')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".editor-terminal")).display'), 'none')
  assert.equal(await evaluate('(async()=> (await window.ame.terminalList("terminal-smoke")).length)()'), 1)
  await evaluate('document.querySelector("button[aria-label=\\"Toggle Terminal\\"]").click()')
  await evaluate('document.querySelector("button[aria-label=\\"New Terminal\\"]").click()')
  await until('document.querySelectorAll(".term-tabs [role=tab]").length === 2')
  await evaluate('document.querySelector(".term-tabs [role=tab]").click()')
  await until(`document.querySelector(".terminal-surface").dataset.terminalId === ${JSON.stringify(id)}`)
  await command('Page.reload')
  await until('document.querySelectorAll(".term-tabs [role=tab]").length === 2')
  assert.ok((await evaluate(`(async()=> (await ${snapshot()}).output)()`)).includes('AME_TERMINAL_OK'), 'Shell output survives renderer reload and tab switching')
  await enter('exit')
  await until(`(async()=> (await ${snapshot()}).exitCode !== undefined)()`)
  await evaluate('document.querySelector("button[aria-label=\\"Kill terminal 1\\"]").click()')
  await until('(async()=> (await window.ame.terminalList("terminal-smoke")).length === 1)()')
  const remaining = await evaluate('(async()=> (await window.ame.terminalList("terminal-smoke"))[0].id)()')
  await evaluate(`window.ame.terminalWrite("terminal-smoke", ${JSON.stringify(remaining)}, ${JSON.stringify('node -e "console.log(\'SHELL_PID:\'+process.ppid)"\r')})`)
  await until(`(async()=> /SHELL_PID:\\d+/.test((await window.ame.terminalSnapshot("terminal-smoke", ${JSON.stringify(remaining)})).output))()`)
  const ownedShellPID = Number((await evaluate(`(async()=> (await window.ame.terminalSnapshot("terminal-smoke", ${JSON.stringify(remaining)})).output)()`)).match(/SHELL_PID:(\d+)/)[1])
  assert.deepEqual(errors, [], 'No renderer errors')
  const exited = new Promise(resolve => child.once('exit', resolve))
  await evaluate('window.ame.window("close")')
  if (process.platform === 'darwin') {
    // macOS keeps the application alive after its last window closes; closing still kills owned shells.
    await sleep(1000)
  } else assert.equal(await Promise.race([exited, sleep(15000).then(() => 'timeout')]), 0)
  let shellStopped = false
  for (let index = 0; index < 50; index++) { try { process.kill(ownedShellPID, 0) } catch { shellStopped = true; break }; await sleep(100) }
  assert.ok(shellStopped, 'Closing the window stops its owned shell')
  console.log(`PASS (${process.platform}-${process.arch}): native PTY, shell cwd with spaces, keyboard input, ANSI, resize, Ctrl+C, tabs, panel hide, renderer reload, exit and owned shell cleanup${packaged ? ', packaged native module' : ''}`)
} catch (error) { console.error(logs); throw error }
finally {
  socket?.close()
  if (process.platform === 'darwin' && child.exitCode === null) {
    // Quit the windowless macOS app through Electron so its private backend can stop normally.
    try {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      const browser = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => { browser.addEventListener('open', resolve, { once: true }); browser.addEventListener('error', reject, { once: true }) })
      browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      for (let index = 0; index < 150 && child.exitCode === null; index++) await sleep(100)
      browser.close()
    } catch {}
  }
  if (child.exitCode === null) child.kill()
  await sleep(500)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
