import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canCommit, commitShortcut } from '../scm-commit'

test('commit shortcut supports Ctrl and Cmd, prevents default and uses staged eligibility', () => {
  const state = { busy: false, message: ' commit ', changes: [{ index: 'M' }] }
  for (const metaKey of [false, true]) {
    let submitted = 0, prevented = 0
    commitShortcut({ key: 'Enter', ctrlKey: !metaKey, metaKey, nativeEvent: { isComposing: false }, preventDefault() { prevented++ } }, state, () => submitted++)
    assert.equal(submitted, 1); assert.equal(prevented, 1)
  }
  for (const invalid of [{ ...state, busy: true }, { ...state, message: ' \n' }, { ...state, changes: [] }, ...[' ', '?', '!'].map(index => ({ ...state, changes: [{ index }] }))]) {
    assert.equal(canCommit(invalid), false)
    let submitted = false
    commitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, nativeEvent: { isComposing: false }, preventDefault() {} }, invalid, () => { submitted = true })
    assert.equal(submitted, false)
  }
})
test('commit ignores composition, unmodified Enter and other keys without preventing input', () => {
  for (const patch of [{ nativeEvent: { isComposing: true } }, { ctrlKey: false }, { key: 'a' }]) {
    let touched = false
    commitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, nativeEvent: { isComposing: false }, preventDefault() { touched = true }, ...patch }, { busy: false, message: 'ok', changes: [{ index: 'A' }] }, () => { touched = true })
    assert.equal(touched, false)
  }
})
