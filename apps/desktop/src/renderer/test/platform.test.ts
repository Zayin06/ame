import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatShortcut, isMacPlatform } from '../platform'

test('only Darwin enables native macOS chrome', () => {
  assert.equal(isMacPlatform('darwin'), true)
  for (const value of [undefined, '', 'win32', 'linux', 'Darwin']) assert.equal(isMacPlatform(value), false)
})

test('shortcut labels keep Windows and Linux intact and order macOS modifiers', () => {
  for (const [input, expected] of [
    ['Ctrl+K', '⌘K'], ['Ctrl+Shift+P', '⇧⌘P'], ['Ctrl+Alt+S', '⌥⌘S'],
    ['Ctrl+Alt+Shift+S', '⇧⌥⌘S'], ['Shift+Alt+Ctrl+S', '⇧⌥⌘S'],
    ['Ctrl+`', '⌘`'], ['Ctrl+Shift+`', '⇧⌘`'], ['Ctrl+,', '⌘,'],
    ['Ctrl+Enter', '⌘Enter'], ['Alt+P', '⌥P'], ['Shift+P', '⇧P'],
    ['Cmd+K', '⌘K'], ['Ctrl / Cmd+Shift+`', '⇧⌘`'], ['Escape', 'Escape'], ['', ''],
  ]) {
    assert.equal(formatShortcut(input, false), input)
    assert.equal(formatShortcut(input, true), expected)
  }
})
