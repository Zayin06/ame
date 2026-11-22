import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createNodeDebugger, type DebugEvent, type NodeDebugger } from '../packages/ide-core/src/debugger'

type EventOf<T extends DebugEvent['type']> = Extract<DebugEvent, { type: T }>

async function fixture(t: TestContext, source: string, entry = 'app.mjs') {
  // Keep every fixture under this checkout, never in the shared system temp directory.
  const root = await mkdtemp(path.join(process.cwd(), 'test', '.debugger-'))
  const events: DebugEvent[] = []
  const listeners = new Set<() => void>()
  const debuggerEngine: NodeDebugger = createNodeDebugger(root, event => {
    events.push(event)
    for (const listener of listeners) listener()
  })
  t.after(async () => {
    await debuggerEngine.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(path.join(root, entry), source)
  function wait<T extends DebugEvent['type']>(type: T, after = 0, predicate: (event: EventOf<T>) => boolean = () => true): Promise<EventOf<T>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(events)}`))
      }, 15_000)
      function check() {
        const found = events.slice(after).find((event): event is EventOf<T> => event.type === type && predicate(event as EventOf<T>))
        if (!found) return
        clearTimeout(timer); listeners.delete(check); resolve(found)
      }
      listeners.add(check)
      check()
    })
  }
  return { root, events, engine: debuggerEngine, wait }
}

function assertDead(pid: number) {
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH', `Debugger child ${pid} must have exited`)
}

test('real CDP hits a pre-breakpoint, exposes scopes, steps, evaluates and exits naturally', { timeout: 30_000 }, async t => {
  const source = [
    'const x = 6; const y = 7;',
    'function calc(a, b) {',
    '  const sum = a + b;',
    '  return sum;',
    '}',
    "console.log('RES=' + calc(x, y));"
  ].join('\n')
  const { engine, events, wait } = await fixture(t, source)
  assert.equal(engine.state().status, 'idle')
  assert.deepEqual(await engine.setBreakpoints('app.mjs', [3, 3]), [{ path: 'app.mjs', line: 3, verified: false }])
  await engine.start({ entry: 'app.mjs' })
  const stopped = await wait('stopped')
  assert.equal(stopped.snapshot.status, 'paused')
  assert.equal(stopped.snapshot.frames[0].path, 'app.mjs')
  assert.equal(stopped.snapshot.frames[0].line, 3)
  assert.ok(stopped.snapshot.frames[0].column >= 1)
  assert.equal(stopped.snapshot.frames[0].functionName, 'calc')
  assert.equal(stopped.snapshot.variables.find(variable => variable.name === 'a')?.value, '6')
  assert.equal(stopped.snapshot.variables.find(variable => variable.name === 'b')?.value, '7')
  assert.equal(stopped.snapshot.breakpoints[0].verified, true)
  assert.ok(stopped.snapshot.breakpoints[0].id)
  assert.equal(events.filter(event => event.type === 'stopped').length, 1, 'Initial inspector entry pause must be auto-resumed')
  const copy = engine.state()
  copy.frames[0].line = 1000
  copy.breakpoints.length = 0
  assert.equal(engine.state().frames[0].line, 3)
  assert.equal(engine.state().breakpoints.length, 1)
  const cursor = events.length
  await engine.stepOver()
  const stepped = await wait('stopped', cursor)
  assert.equal(stepped.snapshot.frames[0].line, 4)
  assert.equal(stepped.snapshot.variables.find(variable => variable.name === 'sum')?.value, '13')
  assert.deepEqual(await engine.evaluate('a + b + 1'), { value: '14', type: 'number' })
  assert.deepEqual(await engine.evaluate('sum', stepped.snapshot.frames[0].callFrameId), { value: '13', type: 'number' })
  const error = await engine.evaluate('missingDebuggerVariable')
  assert.match(error.error ?? '', /ReferenceError/)
  const pid = Number((await engine.evaluate('process.pid')).value)
  await engine.continue()
  assert.equal((await wait('exited')).code, 0)
  assert.equal(engine.state().status, 'exited')
  assert.equal(engine.state().exitCode, 0)
  assert.ok(events.some(event => event.type === 'output' && event.stream === 'stdout' && event.text.includes('RES=13')))
  assert.ok(events.some(event => event.type === 'output' && event.stream === 'console' && event.text.includes('RES=13')))
  assertDead(pid)
  await engine.stop()
  await engine.dispose()
})

test('initial entry auto-resumes without breakpoints, forwards streams and preserves nonzero exit', { timeout: 30_000 }, async t => {
  const { engine, events, wait } = await fixture(t, "console.log('automatic'); console.error('diagnostic'); process.exitCode = 7;\n")
  await engine.start({ entry: 'app.mjs' })
  assert.equal((await wait('exited')).code, 7)
  assert.equal(engine.state().exitCode, 7)
  assert.equal(events.some(event => event.type === 'stopped'), false)
  for (const [stream, text] of [['stdout', 'automatic'], ['stderr', 'diagnostic']] as const) {
    assert.ok(events.some(event => event.type === 'output' && event.stream === stream && event.text.includes(text)))
  }
})

test('replaces/removes live breakpoints and supports stepInto/stepOut', { timeout: 30_000 }, async t => {
  const { engine, events, wait } = await fixture(t, [
    'function inner(n) {',
    '  const doubled = n * 2;',
    '  return doubled;',
    '}',
    'function outer(n) {',
    '  const result = inner(n);',
    '  return result + 1;',
    '}',
    'console.log(outer(4));'
  ].join('\n'))
  await engine.setBreakpoints('app.mjs', [6])
  await engine.start({ entry: 'app.mjs' })
  const first = await wait('stopped')
  assert.equal(first.snapshot.frames[0].line, 6)
  const originalId = first.snapshot.breakpoints[0].id
  const replacements = await engine.setBreakpoints('.\\app.mjs', [7])
  assert.equal(replacements[0].verified, true)
  assert.notEqual(replacements[0].id, originalId)
  let cursor = events.length
  await engine.stepInto()
  const into = await wait('stopped', cursor)
  assert.equal(into.snapshot.frames[0].functionName, 'inner')
  assert.equal(into.snapshot.frames[0].line, 2)
  assert.deepEqual(await engine.evaluate('n'), { value: '4', type: 'number' })
  cursor = events.length
  await engine.stepOut()
  const out = await wait('stopped', cursor)
  assert.equal(out.snapshot.frames[0].functionName, 'outer')
  assert.equal(out.snapshot.frames[0].line, 7)
  assert.deepEqual(await engine.evaluate('result'), { value: '8', type: 'number' })
  assert.deepEqual(await engine.setBreakpoints('app.mjs', []), [])
  await engine.continue()
  assert.equal((await wait('exited')).code, 0)
})

test('runs TypeScript via local tsx, passes literal args/env/cwd and stops without an orphan', { timeout: 30_000 }, async t => {
  const { engine, root, events, wait } = await fixture(t, [
    'const answer: number = 42;',
    'console.log(JSON.stringify({ answer, args: process.argv.slice(2), cwd: process.cwd(), token: process.env.DEBUG_TEST_TOKEN }));',
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'app.ts')
  await mkdir(path.join(root, 'working'))
  await engine.start({ entry: 'app.ts', cwd: 'working', args: ['a b', '& echo not-a-shell', '--inspect=0.0.0.0:9000'], env: { DEBUG_TEST_TOKEN: 'test-value', NODE_OPTIONS: '--inspect=0.0.0.0:9000' } })
  const output = await wait('output', 0, event => event.stream === 'stdout' && event.text.includes('"answer"'))
  const value = JSON.parse(output.text.trim())
  assert.equal(value.answer, 42)
  assert.deepEqual(value.args, ['a b', '& echo not-a-shell', '--inspect=0.0.0.0:9000'])
  assert.equal(value.cwd.toLowerCase(), path.join(root, 'working').toLowerCase())
  assert.equal(value.token, 'test-value')
  assert.equal(events.some(event => event.type === 'stopped'), false)
  assert.equal(events.some(event => event.type === 'output' && event.text.includes('ws://0.0.0.0')), false)
  assert.deepEqual(await engine.evaluate('6 * 7'), { value: '42', type: 'number' })
  const pid = Number((await engine.evaluate('process.pid')).value)
  await assert.rejects(engine.start({ entry: 'app.ts' }), /DEBUG_SESSION_ACTIVE/)
  const cursor = events.length
  await engine.pause()
  assert.equal((await wait('stopped', cursor)).snapshot.status, 'paused')
  await Promise.all([engine.stop(), engine.stop()])
  assert.equal(engine.state().status, 'exited')
  assertDead(pid)
  await engine.dispose()
  await assert.rejects(engine.start({ entry: 'app.ts' }), /DEBUG_DISPOSED/)
})

test('dispose terminates a running child, and stopped sessions can restart safely', { timeout: 30_000 }, async t => {
  const { engine, wait, events } = await fixture(t, "console.log('ready'); setInterval(() => {}, 1000);\n")
  await engine.start({ entry: 'app.mjs', runtime: 'tsx' })
  await wait('output', 0, event => event.stream === 'stdout' && event.text.includes('ready'))
  const firstPid = Number((await engine.evaluate('process.pid')).value)
  await engine.stop()
  assertDead(firstPid)
  const cursor = events.length
  await engine.start({ entry: 'app.mjs' })
  await wait('output', cursor, event => event.stream === 'stdout' && event.text.includes('ready'))
  const secondPid = Number((await engine.evaluate('process.pid')).value)
  await Promise.all([engine.dispose(), engine.dispose()])
  assertDead(secondPid)
  assert.equal(events.filter(event => event.type === 'exited').length, 2)
})

test('rejects every traversal segment, metadata, absolute paths, missing/non-file entries and escaping junctions', { timeout: 30_000 }, async t => {
  const { engine, root } = await fixture(t, 'console.log(1);\n')
  await mkdir(path.join(root, 'sub'))
  for (const name of ['../evil.mjs', 'sub/../app.mjs', 'sub\\..\\app.mjs', '.git/config', '.GIT/config', path.join(root, 'app.mjs'), 'C:\\outside.mjs']) {
    await assert.rejects(engine.setBreakpoints(name, [1]))
    await assert.rejects(engine.start({ entry: name }))
    await assert.rejects(engine.start({ entry: 'app.mjs', cwd: name }))
  }
  await assert.rejects(engine.start({ entry: 'missing.mjs' }), /ENOENT/)
  await assert.rejects(engine.start({ entry: 'sub' }), /DEBUG_ENTRY_NOT_FILE/)
  await writeFile(path.join(root, 'unsupported.txt'), 'text')
  await assert.rejects(engine.start({ entry: 'unsupported.txt' }), /DEBUG_UNSUPPORTED_ENTRY/)
  await assert.rejects(engine.start({ entry: 'app.mjs', cwd: 'app.mjs' }), /NOT_A_DIRECTORY/)
  for (const lines of [[0], [-1], [1.5], [NaN], [Infinity]]) await assert.rejects(engine.setBreakpoints('app.mjs', lines), /DEBUG_INVALID_BREAKPOINT/)
  await assert.rejects(engine.continue(), /DEBUG_NOT_PAUSED/)
  await assert.rejects(engine.evaluate('1'), /DEBUG_NOT_CONNECTED/)
  const outside = await mkdtemp(path.join(process.cwd(), 'test', '.debugger-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(path.join(outside, 'evil.mjs'), 'console.log(1);')
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(engine.start({ entry: 'linked/evil.mjs' }), /SYMLINK_NOT_ALLOWED/)
  await assert.rejects(engine.start({ entry: 'app.mjs', cwd: 'linked' }), /SYMLINK_NOT_ALLOWED/)
  await assert.rejects(engine.setBreakpoints('linked/evil.mjs', [1]), /SYMLINK_NOT_ALLOWED/)
  assert.equal(await readFile(path.join(root, 'app.mjs'), 'utf8'), 'console.log(1);\n')
})

test('Windows file URLs with spaces resolve breakpoints and report normalized workspace paths', { timeout: 30_000 }, async t => {
  const { engine, wait } = await fixture(t, 'function run(value) {\n  return value + 1;\n}\nconsole.log(run(8));\n', 'space # ü.mjs')
  await engine.setBreakpoints('.\\space # ü.mjs', [2])
  await engine.start({ entry: 'space # ü.mjs' })
  const stopped = await wait('stopped')
  assert.equal(stopped.snapshot.frames[0].path, 'space # ü.mjs')
  assert.equal(stopped.snapshot.frames[0].line, 2)
  assert.equal(stopped.snapshot.breakpoints[0].verified, true)
  await engine.continue()
  assert.equal((await wait('exited')).code, 0)
})

test('live replacement removes the old breakpoint and installs the new breakpoint', { timeout: 30_000 }, async t => {
  const { engine, wait, events } = await fixture(t, [
    'function run(n) {',
    '  const first = n + 1;',
    '  const second = first + 1;',
    '  return second;',
    '}',
    'run(1);',
    'run(2);'
  ].join('\n'))
  await engine.setBreakpoints('app.mjs', [2])
  await engine.start({ entry: 'app.mjs' })
  assert.equal((await wait('stopped')).snapshot.frames[0].line, 2)
  await engine.setBreakpoints('app.mjs', [3])
  let cursor = events.length
  await engine.continue()
  assert.equal((await wait('stopped', cursor)).snapshot.frames[0].line, 3)
  cursor = events.length
  await engine.continue()
  const second = await wait('stopped', cursor)
  assert.equal(second.snapshot.frames[0].line, 3, 'Old line 2 breakpoint must not survive replacement')
  assert.deepEqual(await engine.evaluate('n'), { value: '2', type: 'number' })
  await engine.setBreakpoints('app.mjs', [])
  await engine.continue()
  assert.equal((await wait('exited')).code, 0)
})

test('stop cancels a spawned child while the inspector is connecting', { timeout: 30_000 }, async t => {
  const { engine, wait, events } = await fixture(t, 'setInterval(() => {}, 1000);\n')
  const starting = engine.start({ entry: 'app.mjs' }).then(() => undefined, error => error as Error)
  await wait('state', 0, event => event.snapshot.status === 'running')
  await engine.stop()
  assert.match(String(await starting), /DEBUG_SESSION_STOPPED|DEBUG_DISCONNECTED/)
  assert.equal(engine.state().status, 'exited')
  assert.equal(events.filter(event => event.type === 'exited').length, 1)
})

test('revalidates preset breakpoint parents before installation and cleans up the spawned child', { timeout: 30_000 }, async t => {
  const { engine, root, events } = await fixture(t, 'setInterval(() => {}, 1000);\n')
  const parent = path.join(root, 'preset')
  const outside = await mkdtemp(path.join(process.cwd(), 'test', '.debugger-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(parent)
  await writeFile(path.join(parent, 'target.mjs'), 'console.log(1);\n')
  await writeFile(path.join(outside, 'target.mjs'), 'console.log(2);\n')
  await engine.setBreakpoints('preset/target.mjs', [1])
  await rm(parent, { recursive: true })
  await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(engine.start({ entry: 'app.mjs' }), /SYMLINK_NOT_ALLOWED/)
  assert.equal(engine.state().status, 'exited')
  assert.equal(events.filter(event => event.type === 'exited').length, 1)
  assert.equal(events.some(event => event.type === 'stopped'), false)
  assert.equal(engine.state().breakpoints[0].id, undefined)
  await engine.stop()
})

test('TypeScript tsx breakpoint pauses at its source line with arguments and evaluation', { timeout: 30_000 }, async t => {
  const { engine, events, wait } = await fixture(t, [
    'const x: number = 6; const y: number = 7;',
    'function calc(a: number, b: number): number {',
    '  const sum: number = a + b;',
    '  return sum;',
    '}',
    "console.log('TSRES=' + calc(x, y));"
  ].join('\n'), 'app.ts')
  await engine.setBreakpoints('app.ts', [3])
  await engine.start({ entry: 'app.ts', runtime: 'tsx' })
  const stopped = await wait('stopped')
  assert.equal(stopped.snapshot.frames[0].path, 'app.ts')
  assert.equal(stopped.snapshot.frames[0].line, 3)
  assert.equal(stopped.snapshot.frames[0].functionName, 'calc')
  assert.equal(stopped.snapshot.breakpoints[0].verified, true)
  assert.equal(stopped.snapshot.variables.find(variable => variable.name === 'a')?.value, '6')
  assert.equal(stopped.snapshot.variables.find(variable => variable.name === 'b')?.value, '7')
  assert.deepEqual(await engine.evaluate('a + b + 1'), { value: '14', type: 'number' })
  const cursor = events.length
  await engine.stepOver()
  const stepped = await wait('stopped', cursor)
  assert.ok(stepped.snapshot.frames[0].line > 3, 'Stepping must advance beyond the source assignment')
  assert.deepEqual(await engine.evaluate('sum'), { value: '13', type: 'number' })
  await engine.continue()
  assert.equal((await wait('exited')).code, 0)
  assert.ok(events.some(event => event.type === 'output' && event.stream === 'stdout' && event.text.includes('TSRES=13')))
})

test('reserves concurrent startup and permits stop during asynchronous startup', { timeout: 30_000 }, async t => {
  const { engine, events } = await fixture(t, 'setInterval(() => {}, 1000);\n')
  const starting = engine.start({ entry: 'app.mjs' })
  await assert.rejects(engine.start({ entry: 'app.mjs' }), /DEBUG_SESSION_ACTIVE/)
  await engine.stop()
  await assert.rejects(starting, /DEBUG_SESSION_STOPPED/)
  assert.equal(events.filter(event => event.type === 'exited').length, 0, 'Cancelled pre-spawn startup must not launch a process')
})
