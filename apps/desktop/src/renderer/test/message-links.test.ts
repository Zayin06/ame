import assert from 'node:assert/strict'
import { isValidElement, type ReactNode, type ReactElement } from 'react'
import test from 'node:test'
import { MessageContent } from '../components/MessageContent'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

test('chat links use the validated desktop external browser bridge', async () => {
  const links: ReactElement<any>[] = []
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!isValidElement<any>(node)) return
    if (typeof node.type === 'function') { visit((node.type as (props: any) => ReactNode)(node.props)); return }
    if (node.type === 'a') links.push(node)
    visit((node as ReactElement<any>).props.children)
  }
  const opened: string[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { ame: { openExternal: async (url: string) => { opened.push(url) } } } })
  try {
    visit(MessageContent({ text: '[Docs](https://example.com/docs)' }))
    assert.equal(links.length, 1)
    assert.equal(typeof links[0].props.onClick, 'function')
    let prevented = false
    await links[0].props.onClick({ preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.deepEqual(opened, ['https://example.com/docs'])
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('file chips are selectable inline code and support click, Enter and Space without opening on selection', () => {
  const opened: unknown[] = []
  const root = MessageContent({ text: '`src/app.ts:12`', onOpenFile: (...args) => opened.push(args) })
  const paragraph = (root.props as any).children[0]
  const chip = paragraph.props.children[0]
  assert.equal(chip.type, 'code')
  assert.equal(chip.props.className, 'file-chip')
  assert.equal(chip.props.role, 'button')
  assert.equal(chip.props.tabIndex, 0)
  assert.equal(chip.props['aria-label'], 'Mở tệp src/app.ts:12')
  let selected = ''
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { getSelection: () => ({ toString: () => selected }) } })
  try {
    chip.props.onClick()
    selected = 'app.ts'
    chip.props.onClick()
    let prevented = 0
    for (const key of ['Enter', ' ', 'Escape']) chip.props.onKeyDown({ key, preventDefault() { prevented++ } })
    assert.equal(prevented, 2)
    assert.deepEqual(opened, [['src/app.ts', 12], ['src/app.ts', 12], ['src/app.ts', 12]])
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('copy handler writes Markdown only for selections contained in this message', () => {
  const text = '**hello**\n\n- world'
  const root = MessageContent({ text })
  const dom = new JSDOM(`${renderToStaticMarkup(createElement(MessageContent, { text }))}<p id="outside">outside</p>`)
  const container = dom.window.document.querySelector<HTMLElement>('.chat-markdown')!
  const selection = dom.window.getSelection()!
  const range = dom.window.document.createRange()
  range.selectNodeContents(container)
  selection.addRange(range)
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  try {
    let prevented = 0
    const data: unknown[] = []
    const event = { currentTarget: container, clipboardData: { setData: (...args: unknown[]) => data.push(args) }, preventDefault() { prevented++ } }
    ;(root.props as any).onCopy(event)
    assert.deepEqual(data, [['text/plain', text]])
    range.setEnd(dom.window.document.querySelector('#outside')!.firstChild!, 3)
    ;(root.props as any).onCopy(event)
    ;(root.props as any).onCopy({ ...event, clipboardData: null })
    selection.removeAllRanges()
    ;(root.props as any).onCopy(event)
    assert.equal(prevented, 1)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
