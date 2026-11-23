import { spawn, execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackagedExecutable } from './smoke-packaged.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function parseBenchmarkArgs(argv) {
  const result = { json: false, thresholdStartupMs: 15000, thresholdHeapMb: 512, thresholdSwitchMs: 300, thresholdEventLoopLagMs: 100 }
  const numbers = {
    '--threshold-startup-ms': 'thresholdStartupMs', '--threshold-heap-mb': 'thresholdHeapMb',
    '--threshold-switch-ms': 'thresholdSwitchMs', '--threshold-event-loop-lag-ms': 'thresholdEventLoopLagMs',
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--json') result.json = true
    else if (flag === '--dev') result.dev = true
    else if (flag === '--executable') {
      const value = argv[++i]
      if (!value?.trim() || value.startsWith('--')) throw new Error('--executable requires a path')
      result.executable = value
    } else if (Object.hasOwn(numbers, flag)) {
      const value = argv[++i]
      const number = Number(value)
      if (!value?.trim() || !Number.isFinite(number) || number <= 0) throw new Error(`${flag} requires a positive finite number`)
      result[numbers[flag]] = number
    } else throw new Error(`Unknown argument: ${flag}`)
  }
  return result
}

export function resolveExecutable(explicitPath, root, platform) {
  if (explicitPath) {
    const dir = path.dirname(explicitPath)
    const resourcesDir = platform === 'darwin' && path.basename(dir) === 'MacOS'
      ? path.resolve(dir, '../Resources') : path.join(dir, 'resources')
    return { mode: 'packaged', executable: explicitPath, resourcesDir }
  }
  const packaged = findPackagedExecutable(root, platform)
  return packaged ? { mode: 'packaged', ...packaged } : { mode: 'dev', executable: null, resourcesDir: path.join(root, 'resources') }
}

export function evaluateThresholds(metrics, thresholds) {
  const failures = []
  const checks = [
    ['timeToReadyMs', thresholds.thresholdStartupMs, 'Startup'],
    ['jsHeapUsedMB', thresholds.thresholdHeapMb, 'JS heap used'],
  ]
  if ('projectSwitchMaxMs' in metrics && thresholds.thresholdSwitchMs !== undefined) checks.push(['projectSwitchMaxMs', thresholds.thresholdSwitchMs, 'Project switch'])
  if ('ipcPingMaxMs' in metrics && thresholds.thresholdEventLoopLagMs !== undefined) checks.push(['ipcPingMaxMs', thresholds.thresholdEventLoopLagMs, 'IPC ping under LSP load'])
  for (const [key, limit, label] of checks) {
    const value = metrics[key]
    if (!Number.isFinite(value) || value < 0) failures.push(`${label}: metric unavailable or invalid`)
    else if (!Number.isFinite(limit) || limit <= 0) failures.push(`${label}: invalid threshold`)
    else if (value > limit) failures.push(`${label}: ${value.toFixed(2)} exceeds ${limit}`)
  }
  return { ok: failures.length === 0, failures }
}

/** Metrics use milliseconds and MiB (bytes / 1024²); interactive thresholds are optional for older reports. */
export function formatBenchmarkMarkdown(metrics) {
  const number = value => Number.isFinite(value) ? value.toFixed(2) : 'N/A'
  const status = metrics.thresholds ? evaluateThresholds(metrics, metrics.thresholds) : metrics.thresholdStatus
  return [
    '# Desktop benchmark', '', `Mode: ${metrics.mode ?? 'unknown'}`, '',
    '| Metric | Value |', '| --- | ---: |',
    `| Time to ready (ms) | ${number(metrics.timeToReadyMs)} |`,
    `| First paint (ms, navigation-relative) | ${number(metrics.firstPaintMs)} |`,
    `| JS heap used (MiB) | ${number(metrics.jsHeapUsedMB)} |`,
    `| JS heap total (MiB) | ${number(metrics.jsHeapTotalMB)} |`,
    `| Process tree RSS (MiB) | ${number(metrics.processTreeRssMB)} |`,
    ...('projectSwitchAvgMs' in metrics ? [`| Project switch avg (ms) | ${number(metrics.projectSwitchAvgMs)} |`] : []),
    ...('projectSwitchMaxMs' in metrics ? [`| Project switch max (ms) | ${number(metrics.projectSwitchMaxMs)} |`] : []),
    ...('ipcPingMaxMs' in metrics ? [`| IPC ping max under LSP load (ms) | ${number(metrics.ipcPingMaxMs)} |`] : []), '',
    `Threshold status: **${status ? status.ok ? 'PASS' : 'FAIL' : 'NOT EVALUATED'}**`,
    ...(status?.failures ?? []).map(failure => `- ${failure}`),
  ].join('\n')
}

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}
async function treeRss(pid) {
  try {
    let rows
    if (process.platform === 'win32') {
      try {
        const output = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'])
        rows = [].concat(JSON.parse(output)).map(row => [Number(row.ProcessId), Number(row.ParentProcessId), Number(row.WorkingSetSize)])
      } catch {
        const output = await exec('wmic.exe', ['process', 'get', 'ProcessId,ParentProcessId,WorkingSetSize', '/format:csv'])
        const lines = output.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        const header = lines.shift().split(',')
        rows = lines.map(line => { const values = line.split(','); return ['ProcessId', 'ParentProcessId', 'WorkingSetSize'].map(key => Number(values[header.indexOf(key)])) })
      }
    } else {
      const output = await exec('ps', ['-axo', 'pid=,ppid=,rss='])
      rows = output.trim().split('\n').map(line => { const [id, parent, kib] = line.trim().split(/\s+/).map(Number); return [id, parent, kib * 1024] })
    }
    if (!rows.some(row => row[0] === pid)) return null
    const owned = new Set([pid])
    let previous
    do { previous = owned.size; for (const [id, parent] of rows) if (owned.has(parent)) owned.add(id) } while (previous !== owned.size)
    const bytes = rows.filter(row => owned.has(row[0])).reduce((sum, row) => sum + row[2], 0)
    return Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 ** 2 : null
  } catch { return null }
}

async function benchmark(options) {
  const selected = options.dev
    ? { mode: 'dev', executable: null, resourcesDir: path.join(repoRoot, 'resources') }
    : resolveExecutable(options.executable ?? process.env.AME_IDE_PACKAGED_EXECUTABLE, repoRoot, process.platform)
  const executable = selected.executable ?? (await import('electron')).default
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-benchmark-'))
  let child, socket, spawnError, sequence = 0
  let logs = ''
  const pending = new Map()
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const finish = (error, value) => { clearTimeout(timer); pending.delete(id); error ? reject(error) : resolve(value) }
    const timer = setTimeout(() => finish(new Error(`CDP timeout: ${method}`)), 30000)
    pending.set(id, finish)
    try { socket.send(JSON.stringify({ id, method, params })) } catch (error) { finish(error) }
  })
  const evaluate = async expression => {
    const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
    return value.result.value
  }
  try {
    const userData = path.join(root, 'data'), hooks = path.join(root, 'empty-hooks')
    await mkdir(userData); await mkdir(hooks)
    const projects = []
    for (const id of ['alpha', 'beta', 'gamma']) {
      const directory = path.join(root, id)
      await mkdir(directory)
      for (let i = 0; i < 50; i++) {
        const source = i === 0 ? 'export const value0: number = 0\n'
          : `import { value${i - 1} } from './file${i - 1}'\nexport const value${i}: number = value${i - 1} + 1\n`
        await writeFile(path.join(directory, `file${i}.ts`), source)
      }
      await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }))
      await exec('git', ['init', '--quiet', `--template=${hooks}`, directory])
      await exec('git', ['-c', 'core.fsmonitor=false', 'add', '.'], { cwd: directory })
      await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Local benchmark fixture'], { cwd: directory, timeout: 30000 })
      projects.push({ id, directory })
    }
    await writeFile(path.join(userData, 'projects.json'), JSON.stringify(projects))
    const server = net.createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const env = { ...process.env, AME_IDE_TEST_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    const t0 = performance.now()
    child = spawn(executable, [...(selected.mode === 'dev' ? ['.'] : []), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userData}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', error => { spawnError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-16000) })
    const deadline = t0 + Math.max(30000, options.thresholdStartupMs + 15000)
    let target
    while (performance.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Electron exited before readiness')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
        target = (await response.json()).find(item => item.type === 'page' && item.url.startsWith('file:'))
        if (target) break
      } catch {}
      await sleep(100)
    }
    if (!target) throw new Error('Electron file: renderer unavailable')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data)
      if (data.id) pending.get(data.id)?.(data.error ? new Error(JSON.stringify(data.error)) : null, data.result)
    })
    socket.addEventListener('close', () => { for (const finish of [...pending.values()]) finish(new Error('CDP disconnected')) })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timeout')) }, 5000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
    })
    let ready = false
    while (performance.now() < deadline) {
      if (await evaluate('Boolean(window.ame && document.querySelector(".app-shell"))')) { ready = true; break }
      await sleep(50)
    }
    if (!ready) throw new Error('App shell readiness timed out')
    const timeToReadyMs = performance.now() - t0
    await command('Performance.enable')
    const firstPaintMs = await evaluate('performance.getEntriesByType("paint").find(entry => entry.name === "first-paint")?.startTime ?? null')
    await evaluate(`(async () => {
      const deadline = performance.now() + 15000
      while (performance.now() < deadline) {
        const names = [...document.querySelectorAll('.sidebar .project-select .proj-name')].map(node => node.textContent.trim())
        if (['alpha', 'beta', 'gamma'].every(name => names.includes(name)) && document.querySelector('.proj-group.is-active-proj .proj-name')?.textContent.trim() === 'alpha') return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Benchmark project sidebar readiness timed out')
    })()`)
    await evaluate(`(async () => {
      const deadline = performance.now() + 15000
      while (performance.now() < deadline) {
        let timer
        const connection = await Promise.race([
          window.ame.connection().catch(() => undefined),
          new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - performance.now())) }),
        ]).finally(() => clearTimeout(timer))
        if (connection?.connected === true || Boolean(connection?.error)) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    })()`)
    const switchTimes = []
    for (const name of ['beta', 'gamma', 'alpha', 'gamma', 'beta', 'alpha']) {
      switchTimes.push(await evaluate(`(async () => {
        const name = ${JSON.stringify(name)}
        const button = [...document.querySelectorAll('.sidebar .project-select')].find(node => node.querySelector('.proj-name')?.textContent.trim() === name)
        if (!button) throw new Error('Project switch button unavailable: ' + name)
        const start = performance.now()
        button.click()
        while (document.querySelector('.proj-group.is-active-proj .proj-name')?.textContent.trim() !== name) {
          if (performance.now() - start > 10000) throw new Error('Project switch timed out: ' + name)
          await new Promise(resolve => setTimeout(resolve, 0))
        }
        await window.ame.platform()
        return performance.now() - start
      })()`))
    }
    const { ipcPingMaxMs, lspLoadMs } = await evaluate(`(async () => {
      const start = performance.now()
      let complete = false, lspLoadMs = 0, ipcPingMaxMs = 0
      const failures = []
      const load = Promise.all([
        window.ame.lspDiagnostics('alpha'), window.ame.lspDiagnostics('beta'), window.ame.lspDiagnostics('gamma'),
      ].map(request => request.catch(error => { failures.push(String(error)) }))).then(() => {
        lspLoadMs = performance.now() - start
        complete = true
      })
      do {
        const pingStart = performance.now()
        await window.ame.platform()
        ipcPingMaxMs = Math.max(ipcPingMaxMs, performance.now() - pingStart)
        if (!complete) await new Promise(resolve => setTimeout(resolve, 20))
      } while (!complete)
      await load
      if (failures.length) throw new Error('Benchmark LSP load failed: ' + failures.join('; '))
      return { ipcPingMaxMs, lspLoadMs }
    })()`)
    const { metrics } = await command('Performance.getMetrics')
    const values = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
    const result = {
      mode: selected.mode, executable, timeToReadyMs, firstPaintMs,
      projectSwitchAvgMs: switchTimes.reduce((sum, value) => sum + value, 0) / switchTimes.length,
      projectSwitchMaxMs: Math.max(...switchTimes), ipcPingMaxMs, lspLoadMs,
      jsHeapUsedMB: values.JSHeapUsedSize / 1024 ** 2, jsHeapTotalMB: values.JSHeapTotalSize / 1024 ** 2,
      processTreeRssMB: await treeRss(child.pid),
      thresholds: { thresholdStartupMs: options.thresholdStartupMs, thresholdHeapMb: options.thresholdHeapMb, thresholdSwitchMs: options.thresholdSwitchMs, thresholdEventLoopLagMs: options.thresholdEventLoopLagMs },
    }
    result.thresholdStatus = evaluateThresholds(result, result.thresholds)
    return result
  } catch (error) { throw new Error(`${error.message}\n${logs}`, { cause: error }) }
  finally {
    if (socket?.readyState === WebSocket.OPEN) {
      try { await command('Browser.close') } catch {}
    }
    socket?.close()
    for (const finish of [...pending.values()]) finish(new Error('Benchmark stopped'))
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100)
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => {})
        else child.kill('SIGTERM')
        for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100)
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
}

async function main() {
  const options = parseBenchmarkArgs(process.argv.slice(2))
  const metrics = await benchmark(options)
  console.log(options.json ? JSON.stringify(metrics, null, 2) : formatBenchmarkMarkdown(metrics))
  process.exitCode = metrics.thresholdStatus.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
