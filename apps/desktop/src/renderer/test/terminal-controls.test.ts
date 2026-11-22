import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearTerminal, createProjectTerminal, newTerminalShortcut, updateTerminalTheme } from '../terminal-controls'

test('theme updates the existing terminal without recreating or clearing its state; clear is explicit', () => {
  let cleared = 0
  const terminal = { options: { theme: { background: '', foreground: '', cursor: '' } }, buffer: ['retained'], selection: 'selected', scroll: 12, clear() { cleared++ } }
  updateTerminalTheme(terminal, 'light')
  assert.equal(terminal.options.theme.background, '#ffffff')
  updateTerminalTheme(terminal, 'dark')
  assert.equal(terminal.options.theme.background, '#14161a')
  assert.deepEqual(terminal.buffer, ['retained']); assert.equal(terminal.selection, 'selected'); assert.equal(terminal.scroll, 12)
  assert.equal(cleared, 0)
  clearTerminal(terminal); assert.equal(cleared, 1)
  clearTerminal(null); updateTerminalTheme(null, 'dark')
})
test('new terminal shortcut accepts Backquote code or shifted key on Ctrl and Cmd layouts', () => {
  const event = { code: 'Backquote', key: '~', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, isComposing: false }
  assert.equal(newTerminalShortcut(event), true)
  assert.equal(newTerminalShortcut({ ...event, ctrlKey: false, metaKey: true }), true)
  for (const key of ['`', '~']) assert.equal(newTerminalShortcut({ ...event, code: '', key }), true)
  for (const patch of [{ shiftKey: false }, { ctrlKey: false }, { altKey: true }, { isComposing: true }, { code: 'KeyA', key: 'a' }]) assert.equal(newTerminalShortcut({ ...event, ...patch }), false)
})
test('new terminal requires a project and available profile and preserves the chosen project', async () => {
  const calls: unknown[] = []
  const api = { terminalProfiles: async () => [{ id: 'shell', name: 'Shell' }], terminalCreate: async (project: string, profile?: string) => { calls.push([project, profile]); return { id: 'new', projectID: project, profileID: profile!, title: 'Shell', cwd: 'project', cols: 80, rows: 24 } } }
  await createProjectTerminal(api)
  assert.equal(calls.length, 0)
  await createProjectTerminal({ ...api, terminalProfiles: async () => [] }, 'one')
  assert.equal(calls.length, 0)
  assert.equal((await createProjectTerminal(api, 'one'))?.id, 'new')
  assert.deepEqual(calls, [['one', 'shell']])
  await assert.rejects(createProjectTerminal({ ...api, terminalCreate: async () => { throw new Error('FAIL') } }, 'one'), /FAIL/)
})
