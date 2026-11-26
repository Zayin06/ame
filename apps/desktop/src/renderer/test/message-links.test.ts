import assert from 'node:assert/strict'
import { isValidElement, type ReactNode, type ReactElement } from 'react'
import test from 'node:test'
import { MessageContent } from '../components/MessageContent'

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
