import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, stat, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const nonemptyFile = file => { try { const info = statSync(file); return info.isFile() && info.size > 0 } catch { return false } }

/** Synchronous lookup: returns a non-empty executable file and resources path, or null.
 * Explicit overrides never fall back to another build. CLI passes AME_IDE_PACKAGED_EXECUTABLE;
 * helpers do not read the environment. Default release wins, then release-* lexically.
 */
export function findPackagedExecutable(root, platform, explicitPath) {
  const describe = executable => {
    const dir = path.dirname(executable)
    return { executable, resourcesDir: platform === 'darwin' && path.basename(dir) === 'MacOS' ? path.resolve(dir, '../Resources') : path.join(dir, 'resources') }
  }
  if (explicitPath) return nonemptyFile(explicitPath) ? describe(explicitPath) : null
  let releases
  try { releases = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^release(?:-.*)?$/.test(entry.name)).map(entry => entry.name).sort((a, b) => a === 'release' ? -1 : b === 'release' ? 1 : a.localeCompare(b)) }
  catch { return null }
  const layouts = platform === 'win32' ? [path.join('win-unpacked', 'Ame IDE.exe')]
    : platform === 'darwin' ? ['mac-arm64', 'mac', 'mac-universal', 'mac-x64'].map(dir => path.join(dir, 'Ame IDE.app', 'Contents', 'MacOS', 'Ame IDE'))
      : [path.join('linux-unpacked', 'ame-ide'), path.join('linux-unpacked', 'Ame IDE')]
  for (const release of releases) for (const layout of layouts) {
    const candidate = path.join(root, release, layout)
    if (nonemptyFile(candidate)) return describe(candidate)
  }
  return null
}

export async function verifyPackagedResources(resourcesDir, root) {
  const issues = []
  const exists = async file => { try { const info = await stat(file); return info.isFile() && info.size > 0 } catch { return false } }
  const runtime = path.join(resourcesDir, 'opencode')
  const directories = [runtime]
  // prepare-runtime.mjs stages platform/architecture subdirectories, not a flat binary.
  try {
    for (const entry of await readdir(runtime, { withFileTypes: true })) {
      if (entry.isDirectory() && /^(win32|darwin|linux)-(x64|arm64)$/.test(entry.name)) directories.push(path.join(runtime, entry.name))
    }
  } catch {}
  let runtimeFound = false
  for (const directory of directories) {
    if (await exists(path.join(directory, 'opencode.exe')) || await exists(path.join(directory, 'opencode'))) runtimeFound = true
  }
  if (!runtimeFound) issues.push('Missing or empty opencode runtime binary (flat or platform/architecture layout)')
  if (!await exists(path.join(resourcesDir, 'amekit-models', 'server.js'))) issues.push('Missing or empty amekit-models/server.js')
  let petSpriteSha256
  try {
    const sprite = await readFile(path.join(resourcesDir, 'ame-chibi.png'))
    const source = await readFile(path.join(root, 'packages', 'amekit', 'src', 'assets', 'ame-chibi.png'))
    const sha = bytes => createHash('sha256').update(bytes).digest('hex')
    petSpriteSha256 = sha(sprite)
    if (!sprite.length || !source.length || petSpriteSha256 !== sha(source)) issues.push('ame-chibi.png SHA-256 mismatch or empty sprite')
  } catch { issues.push('Missing or unreadable ame-chibi.png (packaged sprite or repository source)') }
  return { ok: issues.length === 0, issues, ...(petSpriteSha256 ? { petSpriteSha256 } : {}) }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--executable' || !args[1]?.trim() || args[1].startsWith('--'))) throw new Error('Usage: node scripts/smoke-packaged.mjs [--executable <path>]')
  const packaged = findPackagedExecutable(repoRoot, process.platform, args[1] ?? process.env.AME_IDE_PACKAGED_EXECUTABLE)
  if (!packaged) throw new Error('Packaged executable not found. Build an unpacked app with npm run package, then pass --executable <path> or AME_IDE_PACKAGED_EXECUTABLE.')
  const resources = await verifyPackagedResources(packaged.resourcesDir, repoRoot)
  assert.ok(resources.ok, resources.issues.join('\n'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-packaged-smoke-'))
  let child, socket, spawnError, sequence = 0, logs = ''
  const pending = new Map(), errors = []
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const finish = (error, result) => { clearTimeout(timer); pending.delete(id); error ? reject(error) : resolve(result) }
    const timer = setTimeout(() => finish(new Error(`CDP timeout: ${method}`)), 5000)
    pending.set(id, finish)
    try { socket.send(JSON.stringify({ id, method, params })) } catch (error) { finish(error) }
  })
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  try {
    const userData = path.join(root, 'data')
    await mkdir(userData)
    await writeFile(path.join(userData, 'projects.json'), '[]')
    const server = net.createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const env = { ...process.env, AME_IDE_TEST_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    child = spawn(packaged.executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userData}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', error => { spawnError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-16000) })
    let target
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Packaged Electron exited early')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
        target = (await response.json()).find(item => item.type === 'page' && item.url.startsWith('file:'))
        if (target) break
      } catch {}
      await sleep(100)
    }
    assert.ok(target, 'Packaged file: renderer was not responsive')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data)
      if (data.id) pending.get(data.id)?.(data.error ? new Error(JSON.stringify(data.error)) : null, data.result)
      if (data.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(data.params.exceptionDetails))
      if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') errors.push(JSON.stringify(data.params.args))
      if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(data.params.entry.text)
    })
    socket.addEventListener('close', () => { for (const finish of [...pending.values()]) finish(new Error('CDP disconnected')) })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timeout')) }, 5000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
    })
    await command('Runtime.enable'); await command('Log.enable')
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (await evaluate('Boolean(window.ame && document.querySelector(".app-shell"))')) { ready = true; break }
      await sleep(100)
    }
    assert.ok(ready, 'App shell readiness timed out')
    assert.equal(await evaluate('typeof window.ame'), 'object')
    assert.equal(await evaluate('typeof window.require'), 'undefined')
    assert.equal(await evaluate('window.ame.platform()'), process.platform)
    assert.equal(await evaluate('(async () => (await window.ame.petSprite()).startsWith("data:image/png;base64,"))()'), true)
    assert.equal(await evaluate('(async () => Array.isArray(await window.ame.projects()))()'), true)
    assert.deepEqual(await evaluate('window.ame.projects()'), [], 'Packaged app must use the isolated empty profile')
    await sleep(500)
    assert.deepEqual(errors, [], 'Uncaught renderer exceptions / console errors')
  } catch (error) { throw new Error(`${error.message}\n${logs}`, { cause: error }) }
  finally {
    // Browser.close reaches Electron's quit lifecycle on macOS as well as Windows.
    if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close') } catch {} }
    socket?.close()
    for (const finish of [...pending.values()]) finish(new Error('Smoke stopped'))
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100)
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => resolve()))
        else child.kill('SIGTERM')
        for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100)
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  console.log(`PASS (packaged): ${process.platform}-${process.arch}; resources SHA-256, sandboxed preload, platform, pet sprite, projects, zero renderer errors`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
