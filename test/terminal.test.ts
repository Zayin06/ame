import assert from 'node:assert/strict'
import test from 'node:test'
import { shellProfiles, Terminals } from '../packages/ide-core/src/terminal'
import type { spawn } from 'node-pty'
import type { TerminalEvent } from '../packages/protocol/src/index'
import type { execFileSync } from 'node:child_process'

test('chunk snapshots retain the exact suffix and exited sessions do not consume live slots', () => {
  const shells: { data(text: string): void; exit(event: { exitCode: number }): void }[] = []
  const launch = (() => {
    const shell = { data: (_text: string) => {}, exit: (_event: { exitCode: number }) => {} }
    shells.push(shell)
    return { onData: (fn: typeof shell.data) => { shell.data = fn; return { dispose() {} } }, onExit: (fn: typeof shell.exit) => { shell.exit = fn; return { dispose() {} } }, kill() {} }
  }) as unknown as typeof spawn
  const service = new Terminals(id => id, () => {}, [{ id: 'sh', name: 'sh', executable: 'sh', args: [] }], launch)
  try {
    const first = service.create('p')
    const chunks = ['a'.repeat(700_000), 'b'.repeat(500_000), 'suffix']
    for (const chunk of chunks) shells[0].data(chunk)
    assert.equal(service.snapshot('p', first.id).output, chunks.join('').slice(-1024 * 1024))
    assert.equal(service.snapshot('p', first.id).sequence, 3)
    shells[0].exit({ exitCode: 0 })
    for (let i = 0; i < 20; i++) { service.create('p'); shells.at(-1)!.exit({ exitCode: 0 }) }
    assert.equal(service.list('p').length, 20)
    assert.throws(() => service.snapshot('p', first.id), /UNKNOWN_TERMINAL/)
    for (let i = 0; i < 20; i++) service.create('p')
    assert.throws(() => service.create('p'), /TERMINAL_LIMIT/)
    assert.equal(service.list('p').length, 40)
  } finally { service.dispose() }
})

test('Windows kills the process tree before the PTY and tolerates taskkill failure', { skip: process.platform !== 'win32' }, () => {
  for (const pid of [123, 0, -1, undefined]) {
    const calls: string[] = []
    const launch = (() => ({ pid, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => calls.push('pty') })) as unknown as typeof spawn
    const killTree = ((file: string, args: string[], options: unknown) => {
      calls.push('tree')
      assert.equal(file, 'taskkill')
      assert.deepEqual(args, ['/PID', '123', '/T', '/F'])
      assert.deepEqual(options, { windowsHide: true, timeout: 2000 })
      throw new Error('already gone')
    }) as unknown as typeof execFileSync
    const service = new Terminals(id => id, () => {}, [{ id: 'sh', name: 'sh', executable: 'sh', args: [] }], launch, killTree)
    service.create('p'); service.dispose()
    assert.deepEqual(calls, pid === 123 ? ['tree', 'pty'] : ['pty'])
  }
})

test('macOS prefers the user login shell and falls back to system zsh/bash without Windows paths', () => {
  const available = new Set(['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash'])
  const profiles = shellProfiles('darwin', { SHELL: '/opt/homebrew/bin/fish' }, file => available.has(String(file)))
  assert.deepEqual(profiles.map(profile => [profile.executable, profile.args]), [['/opt/homebrew/bin/fish', ['-l']], ['/bin/zsh', ['-l']], ['/bin/bash', ['-l']]])
  assert.equal(shellProfiles('darwin', { SHELL: 'invalid' }, file => file === '/bin/zsh')[0].executable, '/bin/zsh')
  assert.equal(shellProfiles('darwin', { SHELL: '/bin/zsh' }, file => file === '/bin/zsh').length, 1)
})

test('Windows profiles use native paths and only offer installed shells', () => {
  const profiles = shellProfiles('win32', { SystemRoot: 'D:\\Windows', ComSpec: 'D:\\Windows\\cmd.exe', ProgramFiles: 'D:\\Programs' }, () => true)
  assert.deepEqual(profiles.map(profile => profile.id), ['pwsh', 'powershell', 'cmd', 'git-bash'])
  assert.equal(profiles[0].executable, 'D:\\Programs\\PowerShell\\7\\pwsh.exe')
  assert.deepEqual(shellProfiles('win32', {}, () => false), [])
})

test('Git Bash discovery uses standard Windows paths in priority order and adds at most one profile', () => {
  const env = { ProgramFiles: 'D:\\Programs', 'ProgramFiles(x86)': 'D:\\Programs (x86)', LOCALAPPDATA: 'D:\\Local' }
  const candidates = ['D:\\Programs\\Git\\bin\\bash.exe', 'D:\\Programs (x86)\\Git\\bin\\bash.exe', 'D:\\Local\\Programs\\Git\\bin\\bash.exe']
  for (let first = 0; first < candidates.length; first++) {
    const available = new Set(candidates.slice(first))
    const profiles = shellProfiles('win32', env, file => available.has(String(file)))
    assert.deepEqual(profiles, [{ id: 'git-bash', name: 'Git Bash', executable: candidates[first], args: ['--login', '-i'] }])
  }
  assert.deepEqual(shellProfiles('win32', {}, file => file === 'C:\\Program Files\\Git\\bin\\bash.exe').map(profile => profile.id), ['git-bash'])
  assert.equal(shellProfiles('win32', env, file => String(file).endsWith('powershell.exe')).some(profile => profile.id === 'git-bash'), false)
  const checked: string[] = []
  shellProfiles('win32', {}, file => { checked.push(String(file)); return false })
  assert.ok(!checked.includes(''))
})

test('closing a project erases only its sessions, disposes listeners and kills only running shells', () => {
  const shells: { killed: number; disposed: number; exit: (event: { exitCode: number }) => void }[] = []
  const launch = (() => {
    const shell = { killed: 0, disposed: 0, exit: (_event: { exitCode: number }) => {} }
    shells.push(shell)
    return {
      onData: () => ({ dispose: () => shell.disposed++ }),
      onExit: (listener: typeof shell.exit) => { shell.exit = listener; return { dispose: () => shell.disposed++ } },
      kill: () => { shell.killed++; if (shells[0] === shell) throw new Error('already exited') },
      write: () => {}, resize: () => {}
    }
  }) as unknown as typeof spawn
  const terminals = new Terminals(id => id, () => {}, [{ id: 'sh', name: 'sh', executable: '/bin/sh', args: [] }], launch)
  try {
    const first = terminals.create('removed'), other = terminals.create('kept'), exited = terminals.create('removed'), last = terminals.create('removed')
    shells[2].exit({ exitCode: 0 })
    terminals.closeProject('removed')
    assert.deepEqual(terminals.list('removed'), [])
    assert.deepEqual(terminals.list('kept'), [other])
    for (const info of [first, exited, last]) assert.throws(() => terminals.snapshot('removed', info.id), /UNKNOWN_TERMINAL/)
    assert.deepEqual(shells.map(shell => [shell.killed, shell.disposed]), [[1, 2], [0, 0], [0, 2], [1, 2]])
    terminals.closeProject('removed')
    terminals.closeProject('unknown')
    assert.deepEqual(shells.map(shell => shell.killed), [1, 0, 0, 1])
  } finally { terminals.dispose() }
})

test('terminal lifecycle scopes project IO, snapshots output, resizes and cleans up', () => {
  let data: (data: string) => void = () => {}, exit: (event: { exitCode: number }) => void = () => {}
  let killed = 0, disposed = 0, options: any
  const writes: string[] = [], sizes: number[][] = [], events: TerminalEvent[] = []
  const launch = ((_file: string, _args: string[], value: unknown) => {
    options = value
    return { onData: (listener: typeof data) => { data = listener; return { dispose: () => disposed++ } }, onExit: (listener: typeof exit) => { exit = listener; return { dispose: () => disposed++ } }, write: (text: string) => writes.push(text), resize: (cols: number, rows: number) => sizes.push([cols, rows]), kill: () => killed++ }
  }) as unknown as typeof spawn
  const service = new Terminals(id => { if (id !== 'project') throw new Error('UNKNOWN_PROJECT'); return '/project' }, event => events.push(event), [{ id: 'sh', name: 'sh', executable: '/bin/sh', args: ['-l'] }], launch)
  assert.throws(() => service.create('missing'), /UNKNOWN_PROJECT/)
  assert.throws(() => service.create('project', 'unknown'), /PROFILE_UNAVAILABLE/)
  assert.throws(() => service.create('project', undefined, 0, 10), /INVALID_TERMINAL_SIZE/)
  const info = service.create('project')
  assert.equal(options.cwd, '/project')
  data('hello\x1b[31m'); data(' world')
  assert.equal(service.snapshot('project', info.id).output, 'hello\x1b[31m world')
  assert.equal(service.snapshot('project', info.id).sequence, 2)
  assert.throws(() => service.write('another', info.id, 'test'), /UNKNOWN_TERMINAL/)
  assert.throws(() => service.write('project', info.id, 'a'.repeat(65537)), /INVALID_TERMINAL_INPUT/)
  service.write('project', info.id, '\x03'); assert.deepEqual(writes, ['\x03'])
  service.resize('project', info.id, 100, 35); service.resize('project', info.id, 100, 35)
  assert.deepEqual(sizes, [[100, 35]])
  data('x'.repeat(1024 * 1024 + 10)); assert.equal(service.snapshot('project', info.id).output.length, 1024 * 1024)
  exit({ exitCode: 7 }); assert.equal(events.at(-1)?.exitCode, 7)
  assert.equal(service.list('project')[0].exitCode, 7)
  assert.throws(() => service.write('project', info.id, 'test'), /TERMINAL_EXITED/)
  service.close('project', info.id); assert.equal(killed, 0); assert.equal(disposed, 2)
  service.create('project'); service.dispose(); assert.equal(killed, 1)
  assert.deepEqual(service.list('project'), [])
})
