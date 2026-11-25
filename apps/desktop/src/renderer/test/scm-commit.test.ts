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
test('amend commits without staged changes but still requires a message and idle state', () => {
  const state = { busy: false, message: ' amended commit ', changes: [], amend: true }
  assert.equal(canCommit(state), true)
  assert.equal(canCommit({ ...state, amend: false }), false)
  for (const metaKey of [false, true]) {
    for (const candidate of [state, { ...state, busy: true }, { ...state, message: ' \n' }]) {
      let submitted = 0, prevented = 0
      const eligible = !candidate.busy && !!candidate.message.trim()
      assert.equal(canCommit(candidate), eligible)
      commitShortcut({ key: 'Enter', ctrlKey: !metaKey, metaKey, nativeEvent: { isComposing: false }, preventDefault() { prevented++ } }, candidate, () => submitted++)
      assert.equal(submitted, eligible ? 1 : 0)
      assert.equal(prevented, 1)
    }
  }
})
test('commit ignores composition, unmodified Enter and other keys without preventing input', () => {
  for (const amend of [false, true]) {
    for (const patch of [{ nativeEvent: { isComposing: true } }, { ctrlKey: false }, { key: 'a' }]) {
      let touched = false
      commitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, nativeEvent: { isComposing: false }, preventDefault() { touched = true }, ...patch }, { busy: false, message: 'ok', changes: amend ? [] : [{ index: 'A' }], amend }, () => { touched = true })
      assert.equal(touched, false)
    }
  }
})
