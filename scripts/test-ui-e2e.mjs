import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPackagedExecutable } from './smoke-packaged.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => JSON.stringify(value)
const usage = 'Usage: npm run test:ui -- [--dev | --executable <path>] [--shots-dir <dir>]'

function options(args) {
  const result = { dev: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--dev' && !result.dev) result.dev = true
    else if (['--executable', '--shots-dir'].includes(arg) && args[index + 1]?.trim() && !args[index + 1].startsWith('--')) {
      const key = arg === '--executable' ? 'executable' : 'shotsDir'
      if (result[key]) throw new Error(usage)
      result[key] = path.resolve(args[++index])
    } else throw new Error(usage)
  }
  if (result.dev && result.executable) throw new Error(usage)
  return result
}

async function fixture(root) {
  const files = {
    alpha: {
      'README.md': '# Alpha UI E2E\n\nSelf-healed workspace content.\n',
      'package.json': '{\n  "name": "alpha-ui-e2e",\n  "private": true\n}\n',
      [path.join('build', 'chrome-mv3-dev', 'manifest.json')]: '{"manifest_version":3,"name":"Alpha fixture","version":"1.0"}\n',
      [path.join('src', 'app.ts')]: 'export const alpha = "real workspace"\n',
      [path.join('assets', 'logo.png')]: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    },
    beta: { 'notes.md': '# Beta notes\n', 'index.ts': 'export const beta = 2\n' },
    gamma: { 'main.ts': 'export const gamma = 3\n' },
  }
  const projects = []
  for (const [id, entries] of Object.entries(files)) {
    const directory = path.join(root, id)
    for (const [relative, content] of Object.entries(entries)) {
      const target = path.join(directory, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    execFileSync('git', ['init', '--quiet', directory], { cwd: root, stdio: 'pipe', windowsHide: true })
    projects.push({ id, directory })
  }
  return projects
}

async function main() {
  const config = options(process.argv.slice(2))
  let executable, launchArgs = []
  if (config.dev) {
    for (const file of [path.join('out', 'main', 'index.js'), path.join('out', 'renderer', 'index.html')]) {
      assert.ok((await stat(path.join(repoRoot, file)).catch(() => null))?.isFile(), `Missing ${file}; run npm run build before test:ui -- --dev`)
    }
    executable = (await import('electron')).default
    launchArgs = [repoRoot]
  } else {
    const packaged = findPackagedExecutable(repoRoot, process.platform, config.executable ?? process.env.AME_IDE_PACKAGED_EXECUTABLE)
    assert.ok(packaged, 'Packaged executable not found. Run npm run package, pass --executable <path>, or use --dev after npm run build.')
    executable = packaged.executable
  }
  // Keep every disposable project/profile inside this checkout, never in a shared OS temp directory.
  const root = await mkdtemp(path.join(repoRoot, '.ame-ui-e2e-'))
  let child, socket, spawnError, interrupted, sequence = 0, logs = '', step = 'fixture setup'
  const pending = new Map(), runtimeErrors = [], consoleErrors = [], logErrors = []
  const interrupt = signal => {
    interrupted = new Error(`Interrupted by ${signal}`)
    for (const finish of [...pending.values()]) finish(interrupted)
  }
  const onSigint = () => interrupt('SIGINT'), onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm)
  function alive() {
    if (interrupted) throw interrupted
    if (spawnError) throw spawnError
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Electron exited unexpectedly (code=${child.exitCode}, signal=${child.signalCode})`)
  }
  function command(method, params = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const finish = (error, value) => { clearTimeout(timer); pending.delete(id); error ? reject(error) : resolve(value) }
      const timer = setTimeout(() => finish(new Error(`CDP timeout: ${method}`)), timeout)
      pending.set(id, finish)
      try { socket.send(JSON.stringify({ id, method, params })) } catch (error) { finish(error) }
    })
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(`DOM evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result.value
  }
  async function diagnostics() {
    try {
      return JSON.stringify(await evaluate(`({url:location.href,theme:document.documentElement.dataset.theme,projects:[...document.querySelectorAll('.proj-group')].map(e=>e.textContent),tabs:[...document.querySelectorAll('.editor-tab')].map(e=>e.textContent),alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.getAttribute('aria-label')),body:document.body.innerText.slice(-4500)})`), null, 2)
    } catch (error) { return `DOM diagnostics unavailable: ${error.message}` }
  }
  async function until(expression, description, timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      alive()
      try { if (await evaluate(expression)) return }
      catch (error) {
        if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message)) throw error
      }
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${description}\nPredicate: ${expression}\n${await diagnostics()}`)
  }
  async function click(selector, description = selector) {
    await until(`(() => {const e=document.querySelector(${quote(selector)});return e && !e.disabled && e.getClientRects().length && getComputedStyle(e).visibility!=='hidden'})()`, `clickable ${description}`)
    let point
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      alive()
      point = await evaluate(`(() => {
        const e=document.querySelector(${quote(selector)}); if(!e) return null;
        e.scrollIntoView({block:'nearest',inline:'nearest'});
        const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`)
      if (!point) { await sleep(100); continue }
      // Hover reveals project actions; remeasure after modal/layout animations before clicking.
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await sleep(100)
      if (await evaluate(`(() => {const e=document.querySelector(${quote(selector)});if(!e)return false;const r=e.getBoundingClientRect();const top=document.elementFromPoint(${point.x},${point.y});return top && e.contains(top) && Math.abs(r.x+r.width/2-${point.x})<1 && Math.abs(r.y+r.height/2-${point.y})<1 && Number(getComputedStyle(e).opacity)>0})()`)) break
      point = null
    }
    assert.ok(point, `No stable unobscured click target: ${description}`)
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  const primary = process.platform === 'darwin' ? 4 : 2
  async function type(selector, value) {
    await click(selector)
    await key('a', 'KeyA', 65, primary)
    await key('Backspace', 'Backspace', 8)
    if (value) await command('Input.insertText', { text: value })
    await until(`document.querySelector(${quote(selector)})?.value === ${quote(value)}`, `input value ${quote(value)}`)
  }
  async function shot(name) {
    if (!config.shotsDir) return
    const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(config.shotsDir, name), Buffer.from(data, 'base64'))
  }
  async function noGlobalError() {
    assert.equal(await evaluate('document.querySelectorAll(".error-banner").length'), 0, 'File reads must not create a global error banner')
    assert.equal(await evaluate('document.body.textContent.includes("INVALID_PATH")'), false, 'Raw INVALID_PATH leaked into the UI')
  }
  async function rendererClean() {
    assert.deepEqual(runtimeErrors, [], 'Uncaught renderer runtime exceptions')
    assert.deepEqual(consoleErrors, [], 'Renderer console.error calls')
    assert.deepEqual(logErrors, [], 'Chromium error log entries')
  }
  async function run(label, action) {
    step = label
    await action()
    console.log(`PASS ${label}`)
  }
  async function waitForExit(timeout) {
    const deadline = Date.now() + timeout
    while (child && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100)
    return !child || child.exitCode !== null || child.signalCode !== null
  }
  try {
    const projects = await fixture(root), alphaDir = projects[0].directory
    const userData = path.join(root, 'user-data')
    await mkdir(userData)
    await writeFile(path.join(userData, 'projects.json'), JSON.stringify(projects))
    await writeFile(path.join(userData, 'pairing.json'), JSON.stringify({ enabled: false, keepScreenActive: false }))
    if (config.shotsDir) await mkdir(config.shotsDir, { recursive: true })
    const env = { ...process.env, AME_IDE_TEST_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    child = spawn(executable, [...launchArgs, `--user-data-dir=${userData}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    child.on('error', error => { spawnError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-18000) })
    let target, port
    for (let attempt = 0; attempt < 300; attempt++) {
      alive()
      try {
        // Chromium atomically chooses the port; its isolated profile identifies the owning launch.
        if (!port) {
          const activePort = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8')
          const candidate = Number(activePort.split(/\r?\n/)[0])
          assert.ok(Number.isInteger(candidate) && candidate > 0 && candidate <= 65535, 'Invalid DevToolsActivePort')
          port = candidate
        }
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
        target = (await response.json()).find(item => item.type === 'page' && item.url.startsWith('file:') && !item.url.includes('pet'))
        if (target) break
      } catch {}
      await sleep(100)
    }
    assert.ok(target, 'Electron file: renderer CDP endpoint did not become responsive')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id) pending.get(message.id)?.(message.error ? new Error(JSON.stringify(message.error)) : null, message.result)
      if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails)
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? arg.type))
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') logErrors.push(message.params.entry)
    })
    socket.addEventListener('close', () => { for (const finish of [...pending.values()]) finish(new Error('Electron CDP disconnected')) })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP WebSocket connection timeout')) }, 10000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket connection failed')) }, { once: true })
    })
    await command('Runtime.enable'); await command('Log.enable'); await command('Page.enable')
    await command('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await until('Boolean(window.ame && document.querySelector(".app-shell")) && document.querySelectorAll(".proj-group").length === 3', 'app shell and all three isolated projects', 30000)
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".project-select .proj-name")].map(e=>e.textContent).sort()'), ['alpha', 'beta', 'gamma'], 'App must load only this suite\'s isolated projects')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".project-select")].map(e=>e.title).sort()'), projects.map(project => project.directory).sort(), 'CDP must attach to this launch and its unique project directories')

    await run('1/7 legacy tabs self-heal and README renders', async () => {
      const absoluteReadme = `${alphaDir}${path.sep}README.md`
      const legacy = { theme: 'dark', project: 'alpha', rail: true, stage: true, inspector: false, terminalOpen: false, panel: 'files', projects: { alpha: { tabs: [{ path: alphaDir, mode: 'file' }, { path: absoluteReadme, mode: 'file' }], active: `file:${alphaDir}`, selectedTabs: { file: `file:${alphaDir}` } } } }
      await evaluate(`localStorage.setItem('ame.ide.layout.v1', ${quote(JSON.stringify(legacy))}); window.__uiE2eBeforeReload = true`)
      await command('Page.reload')
      await until('!window.__uiE2eBeforeReload && Boolean(document.querySelector(".app-shell")) && document.querySelectorAll(".proj-group").length === 3', 'reloaded app with legacy preferences', 30000)
      await until('document.querySelectorAll(".editor-tab").length === 1 && document.querySelector(".editor-tab.selected button")?.title === "README.md" && document.querySelector(".monaco-editor .view-lines")?.textContent.includes("Self-healed")', 'one normalized README tab and actual Monaco content', 30000)
      assert.equal(await evaluate('document.querySelector(".editor-surface").textContent.includes("Đang đọc tệp…")'), false, 'README remained stuck loading')
      await noGlobalError()
      await shot('01-self-healed-open-file.png')
    })

    await run('2/7 project switching, filter, and Explorer binary open', async () => {
      for (const name of ['beta', 'gamma', 'alpha']) {
        await click(`.project-select[title=${quote(projects.find(project => project.id === name).directory)}]`, `select ${name}`)
        await until(`document.querySelector('.is-active-proj .proj-name')?.textContent === ${quote(name)}`, `active sidebar project ${name}`)
      }
      await click('.proj-filter-trigger', 'open Filter popover')
      await until('document.querySelector(".proj-filter-popover.is-open")?.getAttribute("aria-hidden") === "false"', 'visible Filter popover')
      await type('.proj-search-box input', 'beta')
      await until('document.querySelectorAll(".proj-group").length === 1 && document.querySelector(".proj-name")?.textContent === "beta"', 'only beta matches Filter')
      await click('.proj-search-clear', 'clear project filter')
      await until('document.querySelectorAll(".proj-group").length === 3', 'all projects restored')
      await click('.proj-filter-trigger', 'close Filter popover')
      await click('button[aria-label="Tùy chọn dự án: alpha"]', 'alpha project ⋮ menu')
      await click('button[aria-label="Explorer: alpha"]', 'Explorer menu item')
      await until('Boolean(document.querySelector("[data-testid=explorer]"))', 'real Explorer')
      await click('.tree-row[title="assets"]', 'expand assets')
      await click('.tree-row[title="assets/logo.png"]', 'open binary logo.png')
    })

    await run('3/7 friendly inline binary error and close recovery', async () => {
      await until('Boolean(document.querySelector(".editor-load-error[role=alert]"))', 'inline binary load error')
      const message = await evaluate('document.querySelector(".editor-load-error").textContent')
      assert.match(message, /Không thể xem trước tệp nhị phân/, 'Binary error must be humanized in Vietnamese')
      assert.doesNotMatch(message, /BINARY_FILE|INVALID_PATH/, 'Binary error must not expose raw error codes')
      assert.equal(await evaluate('document.querySelector(".editor-surface").textContent.includes("Đang đọc tệp…")'), false, 'Binary read must not remain stuck loading')
      assert.deepEqual(await evaluate('[...document.querySelectorAll(".editor-load-error button")].map(e=>e.textContent)'), ['Thử lại', 'Đóng tab'], 'Inline read error must expose retry and close recovery actions')
      await click('.editor-load-error .button-row button:first-child', 'Thử lại binary read')
      await until('document.querySelector(".editor-load-error")?.textContent.includes("Không thể xem trước tệp nhị phân") && !document.querySelector(".editor-surface").textContent.includes("Đang đọc tệp…")', 'friendly inline binary error after forced retry')
      await noGlobalError()
      await shot('02-binary-file-error-recovery.png')
      await click('.editor-load-error .button-row button:last-child', 'Đóng tab for unreadable binary')
      await until('!document.querySelector(".editor-load-error") && !document.querySelector(\'.editor-tab button[title="assets/logo.png"]\') && document.querySelector(".monaco-editor .view-lines")?.textContent.includes("Self-healed")', 'binary tab closed and readable README recovered')
      await noGlobalError()
    })

    await run('4/7 Ctrl+P package.json and split/merge editor', async () => {
      await key('p', 'KeyP', 80, primary)
      await type('.quick-open__input', 'package.json')
      await until('[...document.querySelectorAll(".quick-open__path")].some(e=>e.textContent === "package.json")', 'package.json in QuickOpen results')
      await key('Enter', 'Enter', 13)
      await until('!document.querySelector(".quick-open") && document.querySelector(".editor-tab.selected button")?.title === "package.json" && document.querySelector(".monaco-editor .view-lines")?.textContent.includes("alpha-ui-e2e")', 'package.json tab with rendered JSON')
      await until('document.querySelector(".editor-toolbar button:last-child")?.textContent === "Chia đôi"', 'Chia đôi toolbar action')
      await click('.editor-toolbar button:last-child', 'Chia đôi')
      await until('document.querySelectorAll(".editor-group").length === 2 && document.querySelectorAll(".editor-group .monaco-editor .view-lines").length === 2 && [...document.querySelectorAll(".editor-group .monaco-editor .view-lines")].every(e=>e.textContent.includes("alpha-ui-e2e"))', 'two editor groups each displaying the live JSON document')
      await until('document.querySelector(".editor-group:first-child .editor-toolbar button:last-child")?.textContent === "Gộp"', 'Gộp toolbar action')
      await click('.editor-group:first-child .editor-toolbar button:last-child', 'Gộp')
      await until('document.querySelectorAll(".editor-group").length === 1', 'merged editor group')
    })

    await run('5/7 real rename collision produces opaque non-overlapping toast', async () => {
      await click('button[aria-label="Thao tác package.json"]', 'package.json Explorer menu')
      await click('button[aria-label="Rename package.json"]', 'Rename package.json')
      await type('.insp-inline-name input[aria-label="Tên mới"]', 'README.md')
      await click('.insp-inline-name button[aria-label="Xác nhận tên"]', 'submit rename collision')
      await until('Boolean(document.querySelector(".error-banner"))', 'rename collision toast')
      const toast = await evaluate(`(() => {
        const e=document.querySelector('.error-banner'),r=e.getBoundingClientRect(),s=getComputedStyle(e);
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d');c.fillStyle=s.backgroundColor;c.fillRect(0,0,1,1);
        return {text:e.textContent,alpha:c.getImageData(0,0,1,1).data[3]/255,opacity:Number(s.opacity),overlaps:['.projects-header','.chat-pane__header','.side-panel__tabs'].map(selector=>{const h=document.querySelector(selector);if(!h)throw new Error('Missing header: '+selector);const b=h.getBoundingClientRect();return {selector,area:Math.max(0,Math.min(r.right,b.right)-Math.max(r.left,b.left))*Math.max(0,Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top))}})};
      })()`)
      assert.match(toast.text, /Tệp hoặc thư mục cùng tên đã tồn tại/, 'Rename collision must have friendly Vietnamese text')
      assert.doesNotMatch(toast.text, /ALREADY_EXISTS|INVALID_PATH/, 'Toast must not expose raw error codes')
      assert.equal(toast.alpha, 1, 'Toast background color must be opaque')
      assert.equal(toast.opacity, 1, 'Toast must not have translucent CSS opacity')
      for (const overlap of toast.overlaps) assert.equal(overlap.area, 0, `Toast overlaps ${overlap.selector}: ${overlap.area}px²`)
      assert.match(await readFile(path.join(alphaDir, 'package.json'), 'utf8'), /alpha-ui-e2e/, 'Collision must preserve source file')
      assert.match(await readFile(path.join(alphaDir, 'README.md'), 'utf8'), /Self-healed/, 'Collision must preserve destination file')
      await shot('03-toast-non-overlap-dark.png')
      await click('.error-banner button[aria-label="Đóng thông báo"]', 'dismiss error toast')
      await until('!document.querySelector(".error-banner")', 'dismissed toast')
      await click('.insp-inline-name button[aria-label="Hủy nhập tên"]', 'cancel failed rename')
    })

    await run('6/7 Settings light theme and no horizontal overflow', async () => {
      await key(',', 'Comma', 188, primary)
      await until('Boolean(document.querySelector(".settings-content select option[value=light]"))', 'Settings appearance theme selector')
      // Native keyboard input drives the same select/change path as a user, without touching React state.
      await evaluate('[...document.querySelectorAll(".settings-content select")].find(e=>e.querySelector("option[value=light]")).focus()')
      await key('End', 'End', 35)
      await key('Enter', 'Enter', 13)
      await until('document.documentElement.dataset.theme === "light"', 'Light theme applied')
      await click('.modal[aria-label="Cài đặt"] header button[aria-label="Đóng"]', 'close Settings')
      await until('!document.querySelector(".modal")', 'Settings closed')
      await command('Runtime.evaluate', { expression: 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', awaitPromise: true })
      const layout = await evaluate(`(() => {
        const selectors=['html','body','.app-shell','.workspace-body'];
        return {theme:document.documentElement.dataset.theme,overflow:selectors.map(selector=>{const e=document.querySelector(selector);if(!e)throw new Error('Missing layout: '+selector);return {selector,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}}),editor:document.querySelector('.monaco-editor .view-lines')?.textContent};
      })()`)
      assert.equal(layout.theme, 'light')
      assert.match(layout.editor, /alpha-ui-e2e/, 'JSON content must remain visible after changing theme')
      for (const surface of layout.overflow) assert.ok(surface.scrollWidth <= surface.clientWidth, `Horizontal overflow at ${surface.selector}: ${surface.scrollWidth} > ${surface.clientWidth}`)
      await noGlobalError()
      await shot('04-light-mode-clean.png')
    })

    await run('7/7 zero runtime/console errors and clean Electron exit', async () => {
      // Allow delayed worker/render failures to surface before and during Electron's quit lifecycle.
      await sleep(500)
      await rendererClean()
      try { await command('Browser.close') } catch (error) { if (socket.readyState === WebSocket.OPEN) throw error }
      assert.ok(await waitForExit(20000), 'Electron failed to quit cleanly within 20 seconds')
      assert.equal(child.signalCode, null, 'Electron must exit without a termination signal')
      assert.equal(child.exitCode, 0, 'Electron must exit with code 0')
      await rendererClean()
    })
  } catch (error) {
    if (socket?.readyState === WebSocket.OPEN) { try { await shot('failure.png') } catch {} }
    throw new Error(`UI E2E failed during ${step}: ${error.message}\nRenderer errors: ${JSON.stringify({ runtimeErrors, consoleErrors, logErrors })}\n${await diagnostics()}\nElectron output (tail):\n${logs}`, { cause: error })
  } finally {
    if (socket?.readyState === WebSocket.OPEN && child?.exitCode === null) { try { await command('Browser.close', {}, 3000) } catch {} }
    socket?.close()
    for (const finish of [...pending.values()]) finish(new Error('UI E2E stopped'))
    if (child?.pid && !await waitForExit(5000)) {
      if (process.platform === 'win32') {
        // Terminate only descendants of this launch and this exact Electron PID; never use process names.
        const script = `function Stop-OwnedTree([int]$ownerId) { Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownerId" | ForEach-Object { Stop-OwnedTree $_.ProcessId }; Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue }; Stop-OwnedTree ${child.pid}`
        await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true }, () => resolve()))
      } else { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
      if (!await waitForExit(3000)) { child.kill('SIGKILL'); await waitForExit(2000) }
    }
    try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }
    finally { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm) }
  }
  console.log(`PASS UI E2E (${config.dev ? 'dev build' : 'packaged'}, ${process.platform}-${process.arch}): all 7 live flows; isolated fixtures cleaned up${config.shotsDir ? `; screenshots: ${config.shotsDir}` : ''}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
