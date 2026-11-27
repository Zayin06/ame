import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { clearRecoveredBuffers, hasUnsavedBuffers, loadInstalledAccount, syncDirtyBuffers, takeRecoveredBuffers } from '../buffer-recovery'

function boundary(props: ConstructorParameters<typeof ErrorBoundary>[0]) {
  const instance = new ErrorBoundary(props)
  // Exercise class transitions synchronously without a browser renderer.
  instance.setState = ((patch: object, callback?: () => void) => {
    instance.state = { ...instance.state, ...patch }
    callback?.()
  }) as typeof instance.setState
  return instance
}

function buttons(node: ReactNode): ReactElement<{ onClick: () => void; children: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<{ onClick: () => void; children: ReactNode }>
  return element.type === 'button' ? [element] : buttons(element.props.children)
}

test('getDerivedStateFromError retains the error', () => {
  const error = new Error('render failed')
  assert.deepEqual(ErrorBoundary.getDerivedStateFromError(error), { error })
})

test('normal children pass through unchanged', () => {
  const child = createElement('span', null, 'editor stays mounted')
  const instance = boundary({ children: child })
  assert.equal(instance.render(), child)
  assert.equal(renderToStaticMarkup(createElement(ErrorBoundary, { children: child })), '<span>editor stays mounted</span>')
})

test('fallback escapes title and message, strips control characters and omits stack', () => {
  const instance = boundary({ children: 'hidden', title: '<img src=x onerror=alert(1)>' })
  instance.state = ErrorBoundary.getDerivedStateFromError(new Error('<script>alert("x")</script>\u0000 & details'))
  const html = renderToStaticMarkup(instance.render())
  assert.match(html, /class="error-boundary"/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; details/)
  assert.doesNotMatch(html, /<script>|<img|\u0000|hidden|\bat Error/)
  assert.match(html, /Thử lại/)
  assert.match(html, /Tải lại giao diện/)
  const defaultTitle = boundary({ children: null })
  defaultTitle.state = { error: new Error('failure') }
  assert.match(renderToStaticMarkup(defaultTitle.render()), /Đã xảy ra lỗi hiển thị/)
})

test('retry clears the error and calls optional onRetry', () => {
  let retried = 0
  const instance = boundary({ children: 'recovered', onRetry: () => { retried++; assert.equal(instance.state.error, null) } })
  instance.state = { error: new Error('failure') }
  buttons(instance.render())[0].props.onClick()
  assert.equal(retried, 1)
  assert.equal(instance.render(), 'recovered')
  const optional = boundary({ children: 'ok' })
  optional.state = { error: new Error('failure') }
  assert.doesNotThrow(() => buttons(optional.render())[0].props.onClick())
  assert.equal(optional.render(), 'ok')
})

test('resetKey changes recover, unchanged keys keep the fallback', () => {
  const instance = boundary({ resetKey: 'project:session:tab', children: 'recovered' })
  const error = new Error('failure')
  instance.state = { error }
  instance.componentDidUpdate({ resetKey: 'project:session:tab', children: null })
  assert.equal(instance.state.error, error)
  instance.componentDidUpdate({ resetKey: 'previous:session:tab', children: null })
  assert.equal(instance.state.error, null)
  assert.equal(instance.render(), 'recovered')
  instance.componentDidUpdate({ resetKey: 'another-key', children: null })
  assert.equal(instance.render(), 'recovered')
})

test('dirty recovery mirrors session storage only and survives missing storage', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const writes = new Map<string, string>()
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      sessionStorage: { getItem: (key: string) => writes.get(key) ?? null, setItem: (key: string, value: string) => writes.set(key, value), removeItem: (key: string) => writes.delete(key) },
      localStorage: { setItem() { assert.fail('buffer text must not enter localStorage') } },
    } })
    const buffer = { projectID: 'one', path: 'a.ts', content: 'disk', text: 'unsaved secret', revision: 'r1', conflict: false }
    syncDirtyBuffers({ dirty: buffer, clean: { ...buffer, path: 'clean.ts', text: 'disk' } })
    assert.equal(hasUnsavedBuffers(), true)
    assert.deepEqual(Object.values(takeRecoveredBuffers()), [buffer])
    assert.deepEqual(JSON.parse(writes.get('ame.ide.dirty-buffers.v1')!), [buffer])
    assert.equal(writes.has('ame.ide.layout.v1'), false)
    clearRecoveredBuffers()
    assert.equal(hasUnsavedBuffers(), false)
    assert.equal(writes.size, 0)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined })
    assert.doesNotThrow(() => syncDirtyBuffers({ dirty: buffer }))
    assert.equal(hasUnsavedBuffers(), true)
    assert.doesNotThrow(clearRecoveredBuffers)
  } finally {
    clearRecoveredBuffers()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('reload confirmation cancels without losing dirty buffers', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let reloads = 0, accepted = false
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: (message: string) => { assert.equal(message, 'Bạn có thay đổi chưa lưu. Vẫn tải lại giao diện?'); return accepted }, location: { reload() { reloads++ } } } })
    syncDirtyBuffers({ dirty: { projectID: 'one', path: 'a.ts', content: 'disk', text: 'edits', revision: 'r1', conflict: false } })
    const instance = boundary({ children: null }); instance.state = { error: new Error('crash') }
    buttons(instance.render())[1].props.onClick()
    assert.equal(reloads, 0); assert.equal(hasUnsavedBuffers(), true)
    accepted = true; buttons(instance.render())[1].props.onClick()
    assert.equal(reloads, 1)
    clearRecoveredBuffers(); buttons(instance.render())[1].props.onClick()
    assert.equal(reloads, 2)
  } finally {
    clearRecoveredBuffers()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('installed lookups coalesce consumers and paired event notifications', async () => {
  let calls = 0
  const loader = () => { calls++; return Promise.resolve({ features: {} }) }
  const first = loadInstalledAccount(loader)
  assert.equal(loadInstalledAccount(loader), first)
  const event = loadInstalledAccount(loader, true)
  assert.equal(loadInstalledAccount(loader, true), event)
  assert.notEqual(first, event)
  assert.equal(calls, 2)
  await Promise.all([first, event])
  await loadInstalledAccount(loader, true)
  assert.equal(calls, 3)
})
