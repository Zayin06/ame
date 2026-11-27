import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { ProjectRail } from '../components/ProjectRail'

test('session controls reveal four at a time and collapse with a compact arrow', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  const sessions = Array.from({ length: 108 }, (_, index) => ({ id: String(index), title: `Chat ${index}`, updatedAt: 108 - index }))
  const noop = () => {}
  try {
    await act(async () => root.render(createElement(ProjectRail, {
      projects: [{ id: 'project', name: 'Project', directory: 'project' }],
      projectID: 'project', sessionID: '107', sessions, sessionCache: { project: sessions }, loading: false, sessionsLoading: false,
      error: '', connected: false, generation: 0, onSelect: noop, onSession: noop,
      onTool: noop, onCreate: noop, onPick: noop, onRetry: noop, onRemove: noop, onSessions: noop,
    })))
    const rows = () => container.querySelectorAll('.session-row').length
    const more = () => container.querySelector<HTMLButtonElement>('.proj-session-controls .proj-see-all:not(.proj-collapse)')
    assert.equal(rows(), 4)
    assert.deepEqual(Array.from(container.querySelectorAll('.nav-item__title'), item => item.textContent), ['Chat 0', 'Chat 1', 'Chat 2', 'Chat 3'])
    assert.equal(more()?.textContent, 'Xem thêm 4 (104)')
    assert.equal(container.querySelector('.proj-collapse'), null)
    for (let count = 8; count <= 108; count += 4) {
      await act(async () => more()!.click())
      assert.equal(rows(), count)
      if (count === 20) assert.equal(more()?.textContent, 'Xem thêm 4 (88)')
    }
    assert.equal(more(), null)
    const collapse = container.querySelector<HTMLButtonElement>('.proj-collapse')!
    assert.equal(collapse.textContent, '↑')
    assert.equal(collapse.getAttribute('aria-label'), 'Thu gọn về 4 cuộc trò chuyện')
    await act(async () => collapse.click())
    assert.equal(rows(), 4)
    assert.deepEqual(Array.from(container.querySelectorAll('.nav-item__title'), item => item.textContent), ['Chat 0', 'Chat 1', 'Chat 2', 'Chat 3'])
    assert.equal(more()?.textContent, 'Xem thêm 4 (104)')
    assert.equal(container.querySelector('.proj-collapse'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
