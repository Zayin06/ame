import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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

async function agentMapFixture(directory) {
  const now = Date.now(), model = { id: 'gpt-6.1-sol', providerID: 'amecode' }
  const tokens = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } })
  const definitions = [
    { id: 'ses_root', title: 'PaywallScreen.kt vùng cuộn độc lập', agent: 'build', outcome: 'succeeded', tokens: tokens(30000, 8200, 2000, 1500, 500), prompt: 'Coordinate the paywall scrolling change and all verification.', output: '## Paywall plan\n\nDelegate layout, build, and lint verification.', skills: [], tools: ['read_file', 'read_file', 'glob', 'grep', 'bash', 'subagent'] },
    { id: 'ses_l1_ui', parentID: 'ses_root', title: 'Adjust paywall scrolling layout', agent: 'android-dev', status: 'running', tokens: tokens(12000, 3200, 500, 1000, 300), prompt: 'Update PaywallScreen.kt scrolling region...', latestPrompt: 'Keep the footer fixed while the content scrolls independently.', output: '## Layout updated\n\nUpdated `src/app.ts:1` for independent scrolling.\n\n```typescript\nexport const alpha = "real workspace"\n```\n\nVerification: layout is ready for the build check.', skills: ['android-dev', 'ui-layout'], tools: ['read_file', 'edit_file', 'subagent'] },
    { id: 'ses_l2_build', parentID: 'ses_l1_ui', title: 'Verify TypeScript & Vite build', agent: 'verifier', outcome: 'succeeded', tokens: tokens(2000, 800), prompt: 'Verify TypeScript and the Vite build for the scrolling change.', output: '## Verification passed\n\nTypeScript and Vite build completed successfully.', skills: ['build-check'], tools: ['bash'] },
    { id: 'ses_l1_lint', parentID: 'ses_root', title: 'Static lint verification', agent: 'linter', outcome: 'failed', tokens: tokens(1500, 400), prompt: 'Run static lint verification on src/app.ts.', output: '## Lint verification\n\nResolve the reported issue in `src/app.ts:1`.', error: { type: 'LintError', message: 'Lint check failed in src/app.ts' }, skills: [], tools: ['bash'] },
  ]
  const sessions = definitions.map((node, index) => ({
    id: node.id, ...(node.parentID ? { parentID: node.parentID } : {}), projectID: 'project_ui_e2e', title: node.title, agent: node.agent, model, cost: 0, tokens: node.tokens,
    ...(node.outcome ? { outcome: node.outcome } : {}), location: { directory },
    time: { created: now - 90000 + index * 1000, updated: now - 1000, busy: now - 60000, ...(node.status === 'running' ? {} : { idle: now - 1000 }) },
  }))
  const histories = new Map(definitions.map((node, index) => {
    const created = sessions[index].time.created
    const messages = [{ id: `${node.id}_user`, type: 'user', time: { created }, text: node.prompt }]
    for (const [ordinal, name] of node.skills.entries()) messages.push({ id: `${node.id}_skill_${ordinal}`, type: 'skill', time: { created: created + 100 + ordinal }, skill: name, name, text: `Loaded ${name}` })
    if (node.latestPrompt) messages.push({ id: `${node.id}_latest`, type: 'user', time: { created: created + 200 }, text: node.latestPrompt })
    messages.push({
      id: `${node.id}_assistant`, type: 'assistant', agent: node.agent, model, tokens: node.tokens, cost: 0,
      time: { created: created + 300, completed: now - 1000 }, finish: node.error ? 'error' : 'stop', ...(node.error ? { error: node.error } : {}),
      content: [
        ...node.tools.flatMap((name, ordinal) => {
          const rootInputs = [{ path: 'README.md' }, { path: 'src/app.ts' }, { pattern: '**/*.ts' }, { pattern: 'alpha', path: 'src' }, { command: 'npm run build' }]
          const input = name === 'subagent' ? { agent: 'verifier', description: 'Verify TypeScript & Vite build', prompt: definitions[2].prompt } : node.id === 'ses_root' ? rootInputs[ordinal] : { path: 'src/app.ts' }
          const tool = { type: 'tool', id: `${node.id}_tool_${ordinal}`, name, time: { created: created + 400 + ordinal * 100, ran: created + 410 + ordinal * 100, completed: created + 490 + ordinal * 100 }, state: node.error ? { status: 'error', input, error: node.error } : { status: 'completed', input, content: [{ type: 'text', text: `${name} completed` }] } }
          return node.id === 'ses_root' && ordinal === 3
            ? [tool, { type: 'text', text: 'Workspace exploration is complete; checking the build before delegating verification.', native: { phase: 'commentary' } }]
            : [tool]
        }),
        { type: 'text', text: node.output, ...(node.id === 'ses_root' ? { native: { phase: 'final_answer' } } : {}) },
      ],
    })
    if (node.outcome) messages.push({ id: `${node.id}_idle`, type: 'idle', time: { created: now - 500 }, outcome: node.outcome, ...(node.error ? { error: node.error } : {}) })
    return [node.id, messages]
  }))
  const streams = new Set(), connections = new Set(), unexpected = [], requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), route = url.pathname
    requests.push(`${req.method} ${route}`)
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && route === '/api/info') return json({ version: '2.3.2', pid: process.pid, urls: [], paths: { tmp: directory } })
    if (req.method === 'GET' && route === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      streams.add(res)
      res.write('data: {"type":"server.connected"}\n\n')
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 5000)
      res.on('close', () => { clearInterval(heartbeat); streams.delete(res) })
      return
    }
    if (req.method === 'POST' && route === '/api/rpc/amekit-models/update') { req.resume(); return json({ output: true }) }
    if (req.method === 'GET' && route === '/api/session') return json({ data: !url.searchParams.get('directory') || path.resolve(url.searchParams.get('directory')) === path.resolve(directory) ? sessions : [], cursor: {} })
    if (req.method === 'GET' && route === '/api/session/active') return json({ data: Object.fromEntries(sessions.filter(s => s.time?.busy !== undefined && (s.time?.idle === undefined || s.time.busy > s.time.idle)).map(s => [s.id, { type: 'running' }])) })
    const sessionRoute = /^\/api\/session\/([^/]+)(?:\/(message|permission|diff|form))?$/.exec(route)
    if (req.method === 'GET' && sessionRoute) {
      const [, id, resource] = sessionRoute
      // Requests already queued while changing backends may still reference the previous native session.
      if (!resource) return json({ data: sessions.find(session => session.id === id) ?? { ...sessions[0], id } })
      if (resource === 'permission' || resource === 'diff' || resource === 'form') return json({ data: [] })
      let messages = [...(histories.get(id) ?? [])]
      if (url.searchParams.has('type')) messages = messages.filter(message => message.type === url.searchParams.get('type'))
      if (url.searchParams.get('order') === 'desc') messages.reverse()
      if (url.searchParams.has('limit')) messages = messages.slice(0, Number(url.searchParams.get('limit')))
      return json({ data: messages, cursor: {} })
    }
    if (req.method === 'GET' && route === '/api/model') return json({ data: [{ ...model, modelID: model.id, name: model.id, type: 'chat', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: now }, cost: [{ input: 0, output: 0 }], status: 'active', enabled: true, limit: { context: 200000, output: 8192 } }] })
    if (req.method === 'GET' && route === '/api/agent') return json({ data: [...new Set(definitions.map(node => node.agent))].map(id => ({ id, name: id, mode: 'all', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] })) })
    if (req.method === 'GET' && route === '/api/skill') return json({ data: ['android-dev', 'ui-layout', 'build-check'].map(name => ({ id: name, name, description: `E2E ${name}`, path: path.join(directory, '.opencode', 'skills', name, 'SKILL.md'), content: `# ${name}` })) })
    if (req.method === 'GET' && ['/api/command', '/api/experimental/artifacts'].includes(route)) return json({ data: [] })
    unexpected.push(`${req.method} ${route}`)
    json({ name: 'NotFoundError', message: `Unexpected fixture endpoint: ${route}` }, 404)
  })
  server.on('connection', connection => { connections.add(connection); connection.on('close', () => connections.delete(connection)) })
  async function close() {
    const closed = new Promise(resolve => server.close(() => resolve()))
    for (const stream of streams) stream.end()
    for (const connection of connections) connection.destroy()
    server.closeAllConnections()
    await closed
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return { url: `http://127.0.0.1:${server.address().port}`, sessions, unexpected, requests, streams, close }
  } catch (error) { await close(); throw error }
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
  let child, socket, mockServer, spawnError, interrupted, sequence = 0, logs = '', step = 'fixture setup'
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
  async function evaluate(expression, timeout = 10000) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeout)
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
    const text = key === 'Enter' && !modifiers ? '\r' : undefined
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) })
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
  async function clickButton(scope, text) {
    const predicate = `(() => {const scope=document.querySelector(${quote(scope)});return scope && [...scope.querySelectorAll('button')].find(e=>e.textContent.trim()===${quote(text)} && e.getClientRects().length)})()`
    await until(`Boolean(${predicate})`, `button ${text} in ${scope}`)
    const selector = await evaluate(`(() => {let e=${predicate};const parts=[];while(e && e!==document.documentElement){parts.unshift(e.tagName.toLowerCase()+':nth-child('+([...e.parentElement.children].indexOf(e)+1)+')');e=e.parentElement}return 'html>'+parts.join('>')})()`)
    await click(selector, text)
  }
  async function setTheme(theme) {
    await key(',', 'Comma', 188, primary)
    await until('Boolean(document.querySelector(".settings-content select option[value=light]"))', 'Settings theme selector')
    await evaluate('[...document.querySelectorAll(".settings-content select")].find(e=>e.querySelector("option[value=light]")).focus()')
    await key(theme === 'dark' ? 'Home' : 'End', theme === 'dark' ? 'Home' : 'End', theme === 'dark' ? 36 : 35)
    await key('Enter', 'Enter', 13)
    await until(`document.documentElement.dataset.theme === ${quote(theme)}`, `${theme} theme applied through Settings`)
    await click('.modal[aria-label="Cài đặt"] header button[aria-label="Đóng"]', 'close Settings')
    await until('!document.querySelector(".modal")', 'Settings closed')
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

    await run('1/10 legacy tabs self-heal and README renders', async () => {
      const absoluteReadme = `${alphaDir}${path.sep}README.md`
      const legacy = { theme: 'dark', project: 'alpha', rail: true, stage: true, inspector: false, terminalOpen: false, panel: 'files', projects: { alpha: { tabs: [{ path: alphaDir, mode: 'file' }, { path: absoluteReadme, mode: 'file' }], active: `file:${alphaDir}`, selectedTabs: { file: `file:${alphaDir}` } } } }
      await evaluate(`localStorage.setItem('ame.ide.layout.v1', ${quote(JSON.stringify(legacy))}); window.__uiE2eBeforeReload = true`)
      await command('Page.reload')
      await until('!window.__uiE2eBeforeReload && Boolean(document.querySelector(".app-shell")) && document.querySelectorAll(".proj-group").length === 3', 'reloaded app with legacy preferences', 30000)
      await until('document.querySelectorAll(".editor-tab").length === 1 && document.querySelector(".editor-tab.selected [data-tab-id]")?.dataset.tabId === "file:README.md" && document.querySelector(".monaco-editor .view-lines")?.textContent.includes("Self-healed")', 'one normalized README tab and actual Monaco content', 30000)
      assert.equal(await evaluate('document.querySelector(".editor-surface").textContent.includes("Đang đọc tệp…")'), false, 'README remained stuck loading')
      await noGlobalError()
      await shot('01-self-healed-open-file.png')
    })

    await run('2/10 project switching, filter, and Explorer binary open', async () => {
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

    await run('3/10 friendly inline binary error and close recovery', async () => {
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
      await until('!document.querySelector(".editor-load-error") && !document.querySelector(\'.editor-tab [data-tab-id="file:assets/logo.png"]\') && document.querySelector(".monaco-editor .view-lines")?.textContent.includes("Self-healed")', 'binary tab closed and readable README recovered')
      await noGlobalError()
    })

    await run('4/10 Ctrl+P package.json and split/merge editor', async () => {
      await key('p', 'KeyP', 80, primary)
      await type('.quick-open__input', 'package.json')
      await until('[...document.querySelectorAll(".quick-open__path")].some(e=>e.textContent === "package.json")', 'package.json in QuickOpen results')
      await key('Enter', 'Enter', 13)
      await until('!document.querySelector(".quick-open") && document.querySelector(".editor-tab.selected [data-tab-id]")?.dataset.tabId === "file:package.json" && document.querySelector(".monaco-editor .view-lines")?.textContent.includes("alpha-ui-e2e")', 'package.json tab with rendered JSON')
      await until('document.querySelector(".editor-toolbar button:last-child")?.textContent === "Chia đôi"', 'Chia đôi toolbar action')
      await click('.editor-toolbar button:last-child', 'Chia đôi')
      await until('document.querySelectorAll(".editor-group").length === 2 && document.querySelectorAll(".editor-group .monaco-editor .view-lines").length === 2 && [...document.querySelectorAll(".editor-group .monaco-editor .view-lines")].every(e=>e.textContent.includes("alpha-ui-e2e"))', 'two editor groups each displaying the live JSON document')
      await until('document.querySelector(".editor-group:first-child .editor-toolbar button:last-child")?.textContent === "Gộp"', 'Gộp toolbar action')
      await click('.editor-group:first-child .editor-toolbar button:last-child', 'Gộp')
      await until('document.querySelectorAll(".editor-group").length === 1', 'merged editor group')
    })

    await run('5/10 real rename collision produces opaque non-overlapping toast', async () => {
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
      await click('button[aria-label="Git Diff"]', 'Inspector Git Diff tab')
      try {
        await until('Boolean(document.querySelector(".scm-commit-dock .scm-enhance-icon-btn svg"))', 'commit Enhance wand icon')
        assert.equal(await evaluate('document.querySelector(".scm-commit-input-bar").textContent.trim()'), '', 'Commit toolbar must contain only the wand icon, without a skill hint or Enhance text')
        await until(`Boolean(document.querySelector('.scm-file-row__main[title="Changes: src/app.ts"] .file-type-icon--ts'))`, 'SCM rows with shared file icons')
        const scm = await evaluate(`(() => {
          const inspector=document.querySelector('[data-testid="inspector"]');
          const style=element=>getComputedStyle(element);
          const neutral=style(inspector).color;
          const row=path=>inspector.querySelector('.scm-file-row__main[title="Changes: '+path+'"]');
          const files=['src/app.ts','README.md','package.json'].map(path=>{
            const main=row(path), container=main.closest('.scm-file-row'), icon=main.querySelector('.file-type-icon'), name=main.querySelector('.scm-file-name'), dir=main.querySelector('.scm-file-dir'), badge=container.querySelector('.git-badge');
            const box=icon.getBoundingClientRect();
            return {path,status:container.dataset.status,badge:badge.textContent,badgeColor:style(badge).color,name:name.textContent,nameColor:style(name).color,dir:dir?.textContent||'',dirColor:dir&&style(dir).color,icon:icon.className,iconColor:style(icon).color,iconWidth:box.width,iconHeight:box.height,background:style(main).backgroundColor,border:style(main).borderTopWidth};
          });
          return {neutral,pills:[...inspector.querySelectorAll('.scm-count-pill')].map(e=>({background:style(e).backgroundColor,color:style(e).color})),files};
        })()`)
        const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number)
        assert.ok(scm.pills.length > 0, 'SCM sections must show count pills')
        for (const pill of scm.pills) {
          const [red, green, blue] = rgb(pill.background)
          assert.ok(blue > red && blue > green, `SCM count pill must be blue: ${pill.background}`)
          assert.equal(pill.color, 'rgb(255, 255, 255)')
        }
        for (const file of scm.files) {
          const kind = file.path.endsWith('.ts') ? 'ts' : file.path.endsWith('.md') ? 'md' : 'json'
          assert.equal(file.status, 'U')
          assert.equal(file.badge, 'U', 'Untracked files must not show raw ? status')
          assert.equal(file.name, file.path.split('/').at(-1))
          assert.equal(file.dir, file.path.includes('/') ? 'src' : '')
          assert.equal(file.nameColor, file.badgeColor)
          assert.notEqual(file.nameColor, scm.neutral, 'Git filenames must not inherit neutral text')
          const [red, green, blue] = rgb(file.badgeColor)
          assert.ok(green > red && green > blue, `Untracked status must be green: ${file.badgeColor}`)
          assert.ok(file.icon.includes('file-type-icon--' + kind))
          assert.notEqual(file.iconColor, scm.neutral)
          assert.ok(new Set(rgb(file.iconColor)).size > 1, 'File icons must not be monochrome')
          assert.equal(file.iconWidth, 16)
          assert.equal(file.iconHeight, 16)
          assert.equal(file.border, '0px')
          assert.equal(file.background, 'rgba(0, 0, 0, 0)')
          if (file.dir) assert.notEqual(file.dirColor, file.nameColor, 'Directory suffix must remain muted')
        }
        assert.equal(new Set(scm.files.map(file => file.iconColor)).size, 3, 'TypeScript, Markdown and JSON icons need distinct colors')
        await evaluate('document.querySelector(".scm-section__toggle").focus()')
        assert.match(await evaluate('getComputedStyle(document.querySelector(".scm-section__actions")).display'), /^(inline-)?flex$/, 'Keyboard focus must reveal section actions')
        await key('Enter', 'Enter', 13)
        await until('document.querySelector(".scm-section").classList.contains("is-folded") && document.querySelector(".scm-section__toggle").getAttribute("aria-expanded") === "false" && getComputedStyle(document.querySelector(".scm-list")).display === "none"', 'folded SCM section')
        await key('Enter', 'Enter', 13)
        await until('document.querySelector(".scm-section__toggle").getAttribute("aria-expanded") === "true" && getComputedStyle(document.querySelector(".scm-list")).display === "flex"', 'expanded SCM section')
        await evaluate('document.querySelector(".scm-file-row__main").focus()')
        assert.match(await evaluate('getComputedStyle(document.querySelector(".scm-file-row:focus-within .scm-row-actions")).display'), /^(inline-)?flex$/, 'Keyboard focus must reveal file actions')
        await evaluate('document.activeElement.blur()')
        await shot('03a-scm-commit-wand-dark.png')
      } finally {
        await click('button[aria-label="Explorer"]', 'restore Inspector Explorer tab')
        await until('Boolean(document.querySelector("[data-testid=explorer]"))', 'restored Explorer')
      }
    })

    await run('6/10 Settings light theme and no horizontal overflow', async () => {
      await key(',', 'Comma', 188, primary)
      await until('Boolean(document.querySelector(".settings-content select option[value=light]"))', 'Settings appearance theme selector')
      const assertSettingsFit = async theme => {
        await command('Runtime.evaluate', { expression: 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', awaitPromise: true })
        const settings = await evaluate(`(() => {
          const content=document.querySelector('.settings-content--general'), modal=content.closest('.modal'), shortcuts=content.querySelector('[data-testid="settings-shortcuts"]');
          const select=content.querySelector('select'), row=select.closest('.setting-row');
          return {theme:document.documentElement.dataset.theme,text:content.textContent,collapsed:!shortcuts.open,scrollHeight:content.scrollHeight,clientHeight:content.clientHeight,scrollWidth:content.scrollWidth,clientWidth:content.clientWidth,modalHeight:modal.getBoundingClientRect().height,height:innerHeight,selectWidth:select.getBoundingClientRect().width,rowWidth:row.clientWidth};
        })()`)
        assert.equal(settings.theme, theme)
        assert.doesNotMatch(settings.text, /máy chủ bên ngoài|Nâng cao|xterm\.js/)
        assert.equal(settings.collapsed, true, 'Shortcuts must start collapsed')
        assert.ok(settings.scrollHeight <= settings.clientHeight, `${theme} Settings vertical cutoff: ${settings.scrollHeight} > ${settings.clientHeight}`)
        assert.ok(settings.scrollWidth <= settings.clientWidth, `${theme} Settings horizontal overflow: ${settings.scrollWidth} > ${settings.clientWidth}`)
        assert.ok(settings.modalHeight <= settings.height * 0.88 + 1, 'Settings must respect the 88dvh modal limit')
        assert.ok(settings.selectWidth >= 112 && settings.selectWidth < settings.rowWidth / 2, 'Theme selector must stay compact')
      }
      await assertSettingsFit('dark')
      await shot('04a-settings-dark.png')
      await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await assertSettingsFit('dark')
      await command('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
      // Native keyboard input drives the same select/change path as a user, without touching React state.
      await evaluate('[...document.querySelectorAll(".settings-content select")].find(e=>e.querySelector("option[value=light]")).focus()')
      await key('End', 'End', 35)
      await key('Enter', 'Enter', 13)
      await until('document.documentElement.dataset.theme === "light"', 'Light theme applied')
      await assertSettingsFit('light')
      await shot('04b-settings-light.png')
      await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await assertSettingsFit('light')
      await command('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
      await click('[data-testid="settings-shortcuts"] summary', 'expand Settings shortcuts')
      await until('document.querySelector("[data-testid=settings-shortcuts]")?.open === true', 'Settings shortcuts expanded')
      const shortcuts = await evaluate(`['dt','dd'].map(tag=>[...document.querySelectorAll('[data-testid="settings-shortcuts"] '+tag)].filter(e=>e.checkVisibility()).length)`)
      assert.deepEqual(shortcuts, [10, 10], 'All ten shortcut keys and descriptions must become visible')
      await shot('04c-settings-shortcuts-light.png')
      await click('[data-testid="settings-shortcuts"] summary', 'collapse Settings shortcuts')
      await until('document.querySelector("[data-testid=settings-shortcuts]")?.open === false', 'Settings shortcuts collapsed')
      await assertSettingsFit('light')
      for (const [tab, selector] of [['AmeKit', '.amekit-core'], ['Pairing', '.pairing-settings'], ['Desktop Pet', '.pet-settings']]) {
        await clickButton('.settings-navigation', tab)
        await until(`Boolean(document.querySelector(${quote(selector)}))`, `${tab} Settings remains selectable`)
        assert.equal(await evaluate(`(() => {const e=document.querySelector(${quote(selector)});return e.scrollWidth>e.clientWidth})()`), false, `${tab} Settings must not overflow horizontally`)
      }
      await clickButton('.settings-navigation', 'Giao diện & hệ thống')
      await assertSettingsFit('light')
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

    await run('7/10 (7A) real bundled OpenCode Agent map', async () => {
      await setTheme('dark')
      await until('window.ame.connection().then(connection=>connection.connected && connection.version === "2.3.2")', 'bundled OpenCode 2.3.2 connection', 30000)
      const session = await evaluate('window.ame.createSession("alpha")')
      assert.ok(session.id, 'Bundled server must create a real session')
      await click('[data-chat-drawer="agents"]', 'open real native session drawer')
      await click(`.agent-row[data-session-id=${quote(session.id)}]`, 'select real bundled session')
      await until(`document.querySelector('.agent-row[data-session-id=${quote(session.id)}]')?.getAttribute('aria-selected') === 'true'`, 'real session selected')
      await click('button[aria-label="Đóng công cụ Chat"]', 'close session drawer')
      await click('[data-testid="agent-map-trigger"]', 'open real Agent map')
      await until('Boolean(document.querySelector(\'[role=dialog][aria-label="Agent map"]\'))', 'real Agent map dialog')
      await click(`.agent-map-card[data-agent-node-id=${quote(session.id)}]`, 'real bundled root card')
      await until('Boolean(document.querySelector(".agent-map-detail__title")) && document.querySelector(".agent-map-detail__meta")?.textContent.includes("main agent")', 'real Agent map detail')
      await until('[...document.querySelectorAll(".agent-map-detail__header button")].some(e=>e.textContent.trim()==="Đang mở" && e.disabled)', 'real current-session action')
      await click('button[aria-label="Đóng Agent map"]', 'close real Agent map')
      await until('!document.querySelector(".agent-map-dialog")', 'real Agent map closed')
      await noGlobalError()
      await rendererClean()
    })

    await run('8/10 (7B) protocol-backed nested Agent map, inspector and themes', async () => {
      mockServer = await agentMapFixture(alphaDir)
      try {
        const response = await fetch(`${mockServer.url}/api/info`, { signal: AbortSignal.timeout(2000) })
        assert.equal(response.status, 200, 'Temporary protocol server must be responsive')
        assert.equal((await response.json()).version, '2.3.2')
        const connected = await evaluate(`window.ame.connect(${quote(mockServer.url)})`, 30000)
        assert.equal(connected.connected, true, 'Desktop must attach to the protocol server')
        assert.equal(connected.url, mockServer.url)
        await click('[data-chat-drawer="agents"]', 'open mock native session drawer')
        await click('.agent-row[data-session-id="ses_l1_ui"]', 'select depth-1 session')
        await until('document.querySelector(\'.agent-row[data-session-id="ses_l1_ui"]\')?.getAttribute("aria-selected") === "true"', 'nested session selected')
        await click('button[aria-label="Đóng công cụ Chat"]', 'close session drawer')
        await until('document.querySelector("[data-testid=agent-map-trigger]")?.textContent.includes("3 subagent")', 'family count on composer Agent map trigger')
        const composerStrip = await evaluate(`(() => {
          const strip=document.querySelector('.composer-context-strip').getBoundingClientRect();
          const chip=document.querySelector('.composer-context-strip .ctx-strip-chip').getBoundingClientRect();
          const trigger=document.querySelector('[data-testid="agent-map-trigger"]').getBoundingClientRect();
          return {chip:{right:chip.right,top:chip.top,height:chip.height},trigger:{left:trigger.left,top:trigger.top,height:trigger.height},height:strip.height};
        })()`)
        assert.ok(composerStrip.chip.right <= composerStrip.trigger.left + 1, 'Context chip must not horizontally overlap the Agent map trigger')
        assert.ok(Math.abs(composerStrip.chip.top - composerStrip.trigger.top) < 4, 'Context chip and Agent map trigger must remain on one row')
        assert.ok(composerStrip.height <= 28 && composerStrip.chip.height <= 28 && composerStrip.trigger.height <= 28, 'Composer context strip must stay within 28px height')
        await shot('05a-composer-strip-dark.png')
        await click('[data-testid="agent-map-trigger"]', 'open nested Agent map')
        await until('document.querySelectorAll(".agent-map-card").length === 4', 'full root-to-depth-2 family loaded from nested session')
        await until('document.querySelector(".agent-map__canvas")?.textContent.includes("/android-dev") && document.querySelector(".agent-map__canvas")?.textContent.includes("/build-check")', 'skill badges on graph')
        // Wait for the modal transition before measuring actual rendered card geometry.
        await sleep(300)
        const graph = await evaluate(`(() => {
          const cards=[...document.querySelectorAll('.agent-map-card')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.agentNodeId,depth:Number(e.dataset.depth),status:e.dataset.status,text:e.textContent,active:e.classList.contains('is-active'),parent:e.closest('.agent-map-branch')?.parentElement?.closest('.agent-map-branch')?.querySelector('.agent-map-card')?.dataset.agentNodeId,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}});
          return {theme:document.documentElement.dataset.theme,cards,subtitle:document.querySelector('.agent-map__subtitle')?.textContent,connectors:document.querySelectorAll('.agent-map-children .agent-map-child').length,nestedButtons:document.querySelectorAll('.agent-map-card button').length,overflow:['.app-shell','.workspace-body'].map(selector=>{const e=document.querySelector(selector);return {selector,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})};
        })()`)
        assert.equal(graph.theme, 'dark')
        assert.match(graph.subtitle, /3 subagent/)
        assert.match(graph.subtitle, /1 đang chạy/)
        assert.equal(graph.connectors, 3, 'Every non-root node must have a connector wrapper')
        assert.equal(graph.nestedButtons, 0, 'Graph cards must never contain nested buttons')
        const expected = [
          { id: 'ses_root', depth: 0, status: 'succeeded', title: 'PaywallScreen.kt vùng cuộn độc lập' },
          { id: 'ses_l1_ui', depth: 1, parent: 'ses_root', status: 'running', title: 'Adjust paywall scrolling layout' },
          { id: 'ses_l2_build', depth: 2, parent: 'ses_l1_ui', status: 'succeeded', title: 'Verify TypeScript & Vite build' },
          { id: 'ses_l1_lint', depth: 1, parent: 'ses_root', status: 'failed', title: 'Static lint verification' },
        ]
        assert.deepEqual(graph.cards.map(card=>card.id).sort(), expected.map(card=>card.id).sort())
        for (const node of expected) {
          const card = graph.cards.find(card=>card.id === node.id)
          assert.equal(card.depth, node.depth, `Depth for ${node.id}`)
          assert.equal(card.status, node.status, `Status for ${node.id}`)
          assert.equal(card.parent, node.parent, `Connector parent for ${node.id}`)
          assert.ok(card.text.includes(node.title), `Missing title for ${node.id}`)
          assert.ok(card.rect.width > 0 && card.rect.height > 0, `Empty card for ${node.id}`)
          if (node.parent) assert.ok(card.rect.left > graph.cards.find(parent=>parent.id === node.parent).rect.right, `Graph must flow left-to-right into ${node.id}`)
        }
        const active = graph.cards.find(card=>card.id === 'ses_l1_ui')
        assert.equal(active.active, true)
        assert.match(active.text, /Đang xem/)
        assert.match(graph.cards.find(card=>card.id === 'ses_root').text, /gpt-6\.1-sol.*42\.2k tokens/)
        for (let i = 0; i < graph.cards.length; i++) for (let j = i + 1; j < graph.cards.length; j++) {
          const a = graph.cards[i], b = graph.cards[j]
          const overlap = Math.max(0, Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left)) * Math.max(0, Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top))
          assert.equal(overlap, 0, `Cards ${a.id} and ${b.id} overlap`)
        }
        for (const surface of graph.overflow) assert.ok(surface.scrollWidth <= surface.clientWidth, `Horizontal overflow at ${surface.selector}`)
        for (const [width, height] of [[1440, 900], [1100, 800]]) {
          await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          const layout = await evaluate(`(() => {const dialog=document.querySelector('.agent-map-dialog').getBoundingClientRect();return {left:dialog.left,right:dialog.right,top:dialog.top,bottom:dialog.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth || document.body.scrollWidth>innerWidth}})()`)
          assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height, `Agent map must fit ${width}×${height}`)
          assert.equal(layout.overflow, false, `Agent map must not overflow the page at ${width}×${height}`)
        }
        await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
        await shot('05-agent-map-graph-dark.png')
        await click('.agent-map-card[data-agent-node-id="ses_l1_ui"]', 'inspect layout subagent')
        await until('document.querySelector(".agent-map-detail__title")?.textContent === "Adjust paywall scrolling layout"', 'layout agent inspector')
        await until('document.querySelector(".agent-map-detail__body .file-chip")?.textContent.includes("src/app.ts")', 'Markdown workspace file chip')
        const detail = await evaluate(`(() => {const body=document.querySelector('.agent-map-detail__body');return {text:body.textContent,meta:body.querySelector('.agent-map-detail__meta')?.textContent,prompt:body.querySelector('.agent-map-prompt')?.textContent,skills:body.querySelector('.agent-map-skill-list')?.textContent,code:body.querySelector('pre code')?.textContent,back:Boolean(document.querySelector('button[aria-label="Quay lại Agent map"] svg')),copyPrompt:Boolean(document.querySelector('button[aria-label="Sao chép prompt"]')),copyOutput:Boolean(document.querySelector('button[aria-label="Sao chép kết quả"]')),actions:[...document.querySelectorAll('.agent-map-detail__header button')].filter(e=>!e.disabled).map(e=>e.textContent.trim())}})()`)
        const detailDialog = await evaluate(`(() => {const dialog=document.querySelector('.agent-map-dialog');return {isDetail:dialog.classList.contains('agent-map-dialog--detail'),width:dialog.getBoundingClientRect().width}})()`)
        assert.equal(detailDialog.isDetail, true, 'Inspector must use the detail dialog modifier')
        assert.ok(detailDialog.width <= 760, 'Inspector must use a compact reading column')
        assert.equal(detail.back, true, 'Inspector must expose the back-arrow control')
        assert.match(detail.meta, /Được gọi bởi\s*PaywallScreen\.kt vùng cuộn độc lập/)
        assert.match(detail.meta, /android-dev.*gpt-6\.1-sol.*subagent L1/)
        assert.match(detail.meta, /In .*Out .*Reasoning .*Cache/)
        assert.match(detail.skills, /\/android-dev/)
        assert.match(detail.skills, /\/ui-layout/)
        assert.equal(detail.prompt, 'Update PaywallScreen.kt scrolling region...')
        for (const heading of ['Skills đã gọi', 'Prompt đầu vào', 'Kết quả đầu ra', 'Công cụ đã dùng', 'Đã gọi subagent:']) assert.ok(detail.text.includes(heading), `Missing inspector section: ${heading}`)
        for (const tool of ['read_file', 'edit_file', 'subagent']) assert.ok(detail.text.includes(tool), `Missing tool: ${tool}`)
        assert.ok(detail.text.includes('Verify TypeScript & Vite build'), 'Inspector must show direct-child jump')
        assert.match(detail.code, /export const alpha = "real workspace"/)
        assert.equal(detail.copyPrompt, true)
        assert.equal(detail.copyOutput, true)
        assert.ok(detail.actions.includes('Dừng'), 'Running node must have stop action')
        assert.equal(await evaluate('[...document.querySelectorAll(".agent-map-detail__header button")].some(e=>e.textContent.trim()==="Đang mở" && e.disabled)'), true, 'Current-session action must be disabled')
        await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
        const detailLayout = await evaluate(`(() => {const dialog=document.querySelector('.agent-map-dialog').getBoundingClientRect();return {left:dialog.left,right:dialog.right,top:dialog.top,bottom:dialog.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth || document.body.scrollWidth>innerWidth}})()`)
        assert.ok(detailLayout.left >= 0 && detailLayout.right <= detailLayout.width && detailLayout.top >= 0 && detailLayout.bottom <= detailLayout.height, 'Agent inspector must fit 1100×800')
        assert.equal(detailLayout.overflow, false, 'Agent inspector must not overflow the page at 1100×800')
        await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
        await shot('06-agent-map-detail-dark.png')
        await click('.agent-map-subdetails summary', 'expand latest prompt')
        await until('document.querySelector(".agent-map-subdetails[open] .agent-map-prompt")?.textContent === "Keep the footer fixed while the content scrolls independently."', 'latest prompt and multi-turn history')
        assert.match(await evaluate('document.querySelector(".agent-map-subdetails summary").textContent'), /2 lượt/)
        await clickButton('.agent-map-detail__meta', 'Verify TypeScript & Vite build')
        await until('document.querySelector(".agent-map-detail__title")?.textContent === "Verify TypeScript & Vite build"', 'child jump to depth-2 inspector')
        assert.match(await evaluate('document.querySelector(".agent-map-detail__body").textContent'), /\/build-check/)
        assert.equal(await evaluate('[...document.querySelectorAll(".agent-map-detail__header button")].some(e=>e.textContent.trim()==="Mở phiên" && !e.disabled)'), true, 'Other-session inspector must enable Mở phiên')
        await key('Escape', 'Escape', 27)
        await until('!document.querySelector(".agent-map-detail__title") && document.querySelectorAll(".agent-map-card").length === 4', 'Escape returns from detail to graph')
        await key('Escape', 'Escape', 27)
        await until('!document.querySelector(".agent-map-dialog")', 'second Escape closes Agent map')

        await click('[data-chat-drawer="agents"]', 'open Agents drawer second entry point')
        await clickButton('[data-testid="chat-drawer"][data-drawer="agents"]', 'Agent map')
        await until('document.querySelectorAll(".agent-map-card").length === 4', 'Agent map opened through Agents drawer')
        await click('.agent-map-card[data-agent-node-id="ses_l1_lint"]', 'inspect failed lint agent')
        await until('document.querySelector(".agent-map-error-box[role=alert]")?.textContent === "Lint check failed in src/app.ts"', 'structured lint failure in inspector')
        assert.match(await evaluate('document.querySelector(".agent-map-detail__meta").textContent'), /Thất bại/)
        await clickButton('.agent-map-detail__meta', 'PaywallScreen.kt vùng cuộn độc lập')
        await until('document.querySelector(".agent-map-detail__title")?.textContent === "PaywallScreen.kt vùng cuộn độc lập"', 'clickable parent jumps to root inspector')
        await click('button[aria-label="Đóng Agent map"]', 'close inspector before Settings')
        await until('!document.querySelector(".agent-map-dialog")', 'inspector closed')
        if (await evaluate('Boolean(document.querySelector(".chat-corner-drawer.is-open"))')) await click('button[aria-label="Đóng công cụ Chat"]', 'close Agents drawer before Settings')
        await setTheme('light')
        await click('[data-chat-drawer="agents"]', 'open Light-theme Agents drawer')
        await clickButton('[data-testid="chat-drawer"][data-drawer="agents"]', 'Agent map')
        await until('document.documentElement.dataset.theme === "light" && document.querySelectorAll(".agent-map-card").length === 4', 'Light Agent map rendered')
        await shot('07-agent-map-light.png')
        await click('button[aria-label="Đóng Agent map"]', 'close Light Agent map')
        await until('!document.querySelector(".agent-map-dialog")', 'Light Agent map closed')
        await noGlobalError()
        await rendererClean()
        assert.ok(mockServer.requests.includes('GET /api/event'), 'Desktop must subscribe to real fixture SSE')
        for (const session of mockServer.sessions) assert.ok(mockServer.requests.includes(`GET /api/session/${session.id}/message`), `Adapter must fetch history for ${session.id}`)
      } finally {
        // Keep SSE and fixture sessions available until Electron exits. startBackend() first
        // disconnects the adapter and then loads the selected mock ID against the native server.
        // The outer finally closes the fixture even when a flow or Electron shutdown fails.
        await noGlobalError()
        await rendererClean()
      }
      assert.deepEqual(mockServer.unexpected, [], 'No unexpected protocol endpoints or 404s')
    })

    await run('9/10 (7C) settled chat timeline, activity rail and Settings presets', async () => {
      if (await evaluate('Boolean(document.querySelector(".chat-corner-drawer.is-open"))')) await click('button[aria-label="Đóng công cụ Chat"]', 'close Agents drawer before timeline checks')
      await setTheme('dark')
      await click('[data-chat-drawer="agents"]', 'open session drawer for settled root')
      await click('.agent-row[data-session-id="ses_root"]', 'select settled root session')
      await until('document.querySelector(\'.agent-row[data-session-id="ses_root"]\')?.getAttribute("aria-selected") === "true"', 'settled root selected')
      await click('button[aria-label="Đóng công cụ Chat"]', 'close session drawer for timeline checks')
      const stream = '.chat-stream__inner', toggle = `${stream} [data-testid="turn-work-toggle"]`
      const commentary = 'Workspace exploration is complete; checking the build before delegating verification.'
      const assertCompact = async theme => {
        await until(`document.documentElement.dataset.theme === ${quote(theme)} && document.querySelectorAll(${quote(toggle)}).length === 1 && document.querySelector(${quote(toggle)})?.getAttribute('aria-expanded') === 'false' && document.querySelector(${quote(stream + ' .msg-agent h2')})?.textContent === 'Paywall plan'`, `${theme} compact summary and rendered final Markdown answer`)
        const compact = await evaluate(`(() => {const e=document.querySelector(${quote(stream)});return {summary:e.querySelector('[data-testid="turn-work-toggle"]').textContent,text:e.textContent,rails:e.querySelectorAll('.turn-work__list').length,cards:e.querySelectorAll('.tool-card').length,live:e.querySelectorAll('.turn-live-status').length}})()`)
        assert.match(compact.summary, /Đã chạy 1 lệnh/, 'Build command must contribute to the compact summary')
        assert.match(compact.summary, /đọc 2 tệp/, 'Both read targets must contribute to the summary')
        assert.match(compact.summary, /tìm 2 lần/, 'Both searches must contribute to the summary')
        assert.match(compact.summary, /1 subagent/, 'Subagent work must remain discoverable')
        assert.doesNotMatch(compact.summary, /gọi \d+ subagent/, 'Trigger must not repeat the subagent badge in its headline')
        const headline = await evaluate(`(() => {const e=document.querySelector(${quote(toggle + ' .turn-work__summary')});return {width:e.clientWidth,scroll:e.scrollWidth,overflow:getComputedStyle(e).textOverflow}})()`)
        assert.ok(headline.scroll <= headline.width, 'Compact headline must not clip mid-word')
        assert.notEqual(headline.overflow, 'ellipsis', 'Compact summary must wrap rather than silently truncate')
        assert.ok(compact.text.includes('Delegate layout, build, and lint verification.'), 'Original root final answer must remain visible')
        assert.equal(compact.text.includes(commentary), false, 'Intermediate commentary must collapse with the work')
        assert.equal(compact.rails, 0, 'Default compact mode must not render the expanded rail')
        assert.equal(compact.cards, 0, 'Settled compact mode must not leak full tool cards')
        assert.equal(compact.live, 0, 'Settled root must not show a live status indicator')
        await evaluate(`document.querySelector(${quote(toggle)}).scrollIntoView({block:'start'})`)
      }
      await assertCompact('dark')
      await shot('08-chat-timeline-compact-dark.png')
      await click(toggle, 'expand settled work summary')
      await until(`document.querySelector(${quote(toggle)})?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll(${quote(stream + ' .turn-work__list .work-row')}).length >= 6`, 'expanded activity rows')
      const expanded = await evaluate(`(() => {const e=document.querySelector(${quote(stream + ' .turn-work__list')});return {text:e.textContent,rail:parseFloat(getComputedStyle(e).borderLeftWidth),rows:[...e.querySelectorAll('.work-row')].map(row=>row.textContent),buttons:[...e.querySelectorAll('button')].map(button=>button.textContent.trim()),cards:e.querySelectorAll('.tool-card').length}})()`)
      assert.ok(expanded.rail > 0, 'Expanded work must display a vertical guide rail')
      assert.ok(expanded.rows.some(text => text.includes('README.md') && text.includes('app.ts')), 'Consecutive reads must share one grouped row')
      for (const text of ['**/*.ts', 'alpha', 'npm run build', 'Verify TypeScript & Vite build', commentary]) assert.ok(expanded.text.includes(text), `Expanded work must expose ${text}`)
      for (const basename of ['README.md', 'app.ts']) assert.ok(expanded.buttons.includes(basename), `Expanded reads must expose a named ${basename} chip`)
      assert.ok(!expanded.buttons.includes('Mở tệp'), 'Workspace chips must not be anonymous duplicates')
      const assertExpandedPolish = async theme => {
        const polish = await evaluate(`(() => {const rail=document.querySelector(${quote(stream + ' .turn-work__list')});return {done:[...rail.querySelectorAll('.work-row--completed > .work-row__line > details > summary')].map(e=>({text:e.textContent,pills:e.querySelectorAll('.turn-work__pill').length,duration:e.querySelector('.work-row__duration') && {background:getComputedStyle(e.querySelector('.work-row__duration')).backgroundColor,border:getComputedStyle(e.querySelector('.work-row__duration')).borderWidth}})),overflow:['html','body','.app-shell','.workspace-body','.chat-stream','.turn-work__list'].map(selector=>{const e=document.querySelector(selector);return {selector,scroll:e.scrollWidth,width:e.clientWidth}})}})()`)
        assert.ok(polish.done.length >= 4, 'Expanded rail must contain completed tool rows')
        for (const row of polish.done) {
          assert.equal(row.pills, 0, `${theme}: completed steps must not have status pills`)
          assert.doesNotMatch(row.text, /Hoàn tất/, 'Routine completion label must be omitted')
          assert.ok(row.duration, 'Completed fixture tools must expose a duration')
          assert.equal(row.duration.border, '0px', 'Duration must be unboxed')
          assert.equal(row.duration.background, 'rgba(0, 0, 0, 0)', 'Duration must have no background')
        }
        for (const surface of polish.overflow) assert.ok(surface.scroll <= surface.width, `${theme} expanded timeline overflows ${surface.selector}`)
      }
      await assertExpandedPolish('dark')
      for (const [target, basename] of [['README.md', 'README.md'], ['src/app.ts', 'app.ts']]) {
        const chip = `${stream} .work-row--read-group > .work-row__line > .work-row__actions button[aria-label="Mở tệp ${target}"]`
        assert.equal(await evaluate(`document.querySelector(${quote(chip)}).title`), `Mở tệp: ${target}`)
        await click(chip, `open the specific ${basename} filename chip`)
        await until(`document.querySelector('.editor-tab.selected [data-tab-mode="file"]')?.dataset.tabPath === ${quote(target)} && document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\\s/g, ' ').includes(${quote(basename === 'README.md' ? 'Alpha UI E2E' : 'real workspace')})`, `${basename} chip opens its matching workspace content`)
      }
      assert.ok(expanded.buttons.includes('Agent map'), 'Expanded subagent row must expose Agent map')
      assert.equal(expanded.cards, 0, 'Activity rail must use compact rows, not legacy tool cards')
      await evaluate(`document.querySelector(${quote(toggle)}).scrollIntoView({block:'start'})`)
      await shot('09-chat-timeline-expanded-dark.png')
      await clickButton(`${stream} .turn-work__list`, 'Agent map')
      await until('document.querySelectorAll(".agent-map-card").length === 4', 'Agent map opened from activity rail')
      await click('button[aria-label="Đóng Agent map"]', 'close activity rail Agent map')
      await until('!document.querySelector(".agent-map-dialog")', 'activity rail Agent map closed')
      await click(toggle, 'collapse settled work before changing presets')
      await assertCompact('dark')

      const setTimelinePreset = async (label, expected) => {
        await key(',', 'Comma', 188, primary)
        await until('[...document.querySelectorAll(".settings-content .setting-row__title")].some(e=>e.textContent.trim()==="Tiến trình chat")', 'Vietnamese timeline preset setting')
        const rowSelector = await evaluate(`(() => {const row=[...document.querySelectorAll('.settings-content .setting-row')].find(e=>e.querySelector('.setting-row__title')?.textContent.trim()==='Tiến trình chat');return '.settings-content .setting-row[data-setting="'+row.dataset.setting+'"]'})()`)
        assert.deepEqual(await evaluate(`[...document.querySelector(${quote(rowSelector)}).querySelectorAll('.segmented button')].map(e=>e.textContent.trim())`), ['Gọn', 'Chi tiết', 'Đầy đủ'], 'Timeline presets must use unambiguous Vietnamese labels')
        await clickButton(rowSelector, label)
        await until(`document.querySelector(${quote(rowSelector + ' .segmented .is-active')})?.textContent.trim() === ${quote(label)} && JSON.parse(localStorage.getItem('ame.ide.layout.v1'))?.timelineDetail === ${quote(expected)}`, `${label} timeline preference applied and persisted`)
        await click('.modal[aria-label="Cài đặt"] header button[aria-label="Đóng"]', 'close timeline Settings')
        await until('!document.querySelector(".modal")', 'timeline Settings closed')
      }
      await setTimelinePreset('Đầy đủ', 'everything')
      await until(`document.querySelectorAll(${quote(stream + ' .tool-card')}).length === 6 && !document.querySelector(${quote(toggle)})`, 'all six individual tool cards in Đầy đủ mode')
      assert.ok(await evaluate(`document.querySelector(${quote(stream)}).textContent.includes(${quote(commentary)})`), 'Đầy đủ must keep intermediate commentary inline')
      assert.equal(await evaluate(`document.querySelector(${quote(stream + ' .msg-agent h2')})?.textContent`), 'Paywall plan', 'Preset switch must preserve final Markdown')
      await setTimelinePreset('Gọn', 'compact')
      await assertCompact('dark')
      await setTheme('light')
      await assertCompact('light')
      const overflow = await evaluate(`['html','body','.app-shell','.workspace-body','.chat-stream'].map(selector=>{const e=document.querySelector(selector);return {selector,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})`)
      for (const surface of overflow) assert.ok(surface.scrollWidth <= surface.clientWidth, `Light compact timeline overflows ${surface.selector}`)
      await shot('10-chat-timeline-compact-light.png')
      await click(toggle, 'expand settled activity rail in Light theme')
      await until(`document.querySelector(${quote(toggle)})?.getAttribute('aria-expanded') === 'true'`, 'Light expanded activity rail')
      await assertExpandedPolish('light')
      await evaluate(`document.querySelector(${quote(toggle)}).scrollIntoView({block:'start'})`)
      await shot('10a-chat-timeline-expanded-light.png')
      await click(toggle, 'restore Light compact state')
      await assertCompact('light')
      await noGlobalError()
      await rendererClean()
      assert.deepEqual(mockServer.unexpected, [], 'Timeline and Settings must not request unexpected protocol endpoints')
    })

    await run('10/10 zero runtime/console errors and clean Electron exit', async () => {
      // Allow delayed worker/render failures to surface before and during Electron's quit lifecycle.
      await sleep(500)
      await rendererClean()
      try { await command('Browser.close') } catch (error) { if (socket.readyState === WebSocket.OPEN) throw error }
      assert.ok(await waitForExit(20000), 'Electron failed to quit cleanly within 20 seconds')
      assert.equal(child.signalCode, null, 'Electron must exit without a termination signal')
      assert.equal(child.exitCode, 0, 'Electron must exit with code 0')
      await rendererClean()
      await mockServer.close()
      assert.equal(mockServer.streams.size, 0, 'All mock SSE responses must be closed after Electron exits')
      assert.deepEqual(mockServer.unexpected, [], 'No unexpected protocol endpoints during shutdown')
      mockServer = undefined
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
    try { if (mockServer) await mockServer.close() }
    finally {
      try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }
      finally { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm) }
    }
  }
  console.log(`PASS UI E2E (${config.dev ? 'dev build' : 'packaged'}, ${process.platform}-${process.arch}): all 10 live flows (including Agent map 7A + 7B and timeline 7C); isolated fixtures cleaned up${config.shotsDir ? `; screenshots: ${config.shotsDir}` : ''}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
