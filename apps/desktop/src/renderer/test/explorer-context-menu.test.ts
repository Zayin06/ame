import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactNode, type ReactElement } from 'react'
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript'

type Node = ReactElement<Record<string, any>>
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const file = { path: 'src/a.ts', name: 'a.ts', directory: false }
const dir = { path: 'src', name: 'src', directory: true }
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!isValidElement<Record<string, any>>(node)) return []
  return [node, ...nodes(node.props.children)]
}
function environment(api: Record<string, any> = {}, confirm = (_message: string) => true) {
  let active: any
  const hooks = {
    useState(initial: any) {
      const h = active, i = h.cursor++
      if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial
      return [h.slots[i], (next: any) => { h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next }]
    },
    useRef(initial: any) { const h = active, i = h.cursor++; return h.slots[i] ??= { current: initial } },
    useEffect(run: any, deps: any[]) {
      const h = active, i = h.effectIndex++, old = h.effects[i]
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) h.pending.push(() => { old?.cleanup?.(); h.effects[i] = { deps, cleanup: run() } })
    },
  }
  const nativeRequire = createRequire(import.meta.url), exports: Record<string, any> = {}
  const source = readFileSync(new URL('../components/Inspector.tsx', import.meta.url), 'utf8')
  const code = transpileModule(source + '\nexports.testing = { Explorer, Directory, pasteDirectory };', { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText
  const stub = () => null
  const modules: Record<string, any> = { react: hooks, './Icon': { Icon: stub }, './Primitives': { errorText: String }, '../components/FileTypeIcon': { FileTypeIcon: stub }, './ProjectSearch': { ProjectSearch: stub } }
  const calls: any[][] = []
  const ame = {
    entries: async () => [file, dir],
    copyPath: async (...args: any[]) => { calls.push(['copy', ...args]); return { path: 'copy', directory: false } },
    movePath: async (...args: any[]) => { calls.push(['move', ...args]); return { from: args[2], to: 'dest/a.ts', directory: false, moved: true, sameProject: args[0] === args[1] } },
    pasteClipboardFiles: async (...args: any[]) => { calls.push(['os', ...args]); return { paths: ['os'] } },
    revealPath: async (...args: any[]) => { calls.push(['reveal', ...args]) },
    ...api,
  }
  runInNewContext(code, { exports, window: { ame, confirm, addEventListener() {}, removeEventListener() {}, innerWidth: 800, innerHeight: 600 }, require: (name: string) => modules[name] ?? nativeRequire(name) })
  function mount(component = exports.testing.Explorer, extra: Record<string, any> = {}) {
    const h = { slots: [] as any[], effects: [] as any[], pending: [] as any[], cursor: 0, effectIndex: 0 }
    let tree: ReactNode
    const props = { projectID: 'a', name: 'A', generation: 0, busy: false, onOpen() {}, onRename(...args: any[]) { calls.push(['rename', ...args]) }, onDelete(...args: any[]) { calls.push(['delete', ...args]) }, async mutate(action: any, success?: any) { const result = await action(); success?.(result) }, ...extra }
    const render = () => { active = h; h.cursor = 0; h.effectIndex = 0; tree = component(props); h.pending.splice(0).forEach(run => run()); return tree }
    const find = (predicate: (node: Node) => boolean) => { const found = nodes(tree).find(predicate); assert.ok(found, 'expected control'); return found }
    const label = (value: string) => find(node => node.props['aria-label'] === value)
    render()
    return {
      render, find, label,
      click(value: string) { const node = label(value); assert.notEqual(node.props.disabled, true); node.props.onClick() },
      open(entry: any = null) { const directory = find(node => node.type === exports.testing.Directory); directory.props.openMenu(entry, 790, 590); render() },
      key(key: string, extra = {}) { find(node => node.props['data-testid'] === 'explorer').props.onKeyDown({ key, ctrlKey: true, target: { closest: () => false }, preventDefault() {}, stopPropagation() {}, ...extra }); render() },
      directoryProps() { return find(node => node.type === exports.testing.Directory).props },
      async flush() { await tick(); render(); await tick(); render() },
      unmount() { h.effects.forEach(effect => effect.cleanup?.()) },
    }
  }
  return { mount, calls, testing: exports.testing }
}

test('file, directory and root context menus preserve labels and resolve paste targets', async () => {
  const e = environment(), h = e.mount()
  h.open(file)
  for (const label of ['Rename src/a.ts', 'Copy Path src/a.ts', 'Reveal in OS src/a.ts', 'Delete src/a.ts', 'Cut src/a.ts', 'Copy src/a.ts', 'Duplicate src/a.ts']) h.label(label)
  assert.equal(h.label('Paste').props.disabled, true)
  assert.throws(() => h.label('New File trong src'))
  assert.equal(h.find(node => node.props.role === 'menu').props.className, 'insp-tree-popover insp-context-menu')
  h.open(dir); h.label('New File trong src'); h.label('New Folder trong src')
  h.open(); h.label('New File trong '); h.label('New Folder trong ')
  for (const action of ['Rename', 'Delete', 'Cut', 'Copy Path', 'Duplicate']) assert.throws(() => h.find(node => node.props['aria-label']?.startsWith(`${action} `)))
  assert.equal(h.directoryProps().menu.kind, 'root')
  h.click('Reveal in OS '); await h.flush(); assert.deepEqual(e.calls, [['reveal', 'a', '']])
  assert.equal(e.testing.pasteDirectory(file), 'src'); assert.equal(e.testing.pasteDirectory(dir), 'src'); assert.equal(e.testing.pasteDirectory(null), '')
  h.unmount()
})

test('copy, duplicate and OS paste route APIs; internal clipboard wins unless OS explicitly selected', async () => {
  const e = environment({ clipboardFiles: async () => ({ hasFiles: true, names: ['os'], count: 1 }) }), h = e.mount()
  h.open(file); h.click('Duplicate src/a.ts'); await h.flush()
  h.open(file); h.click('Copy src/a.ts'); h.render()
  h.open(dir); await h.flush(); h.label('Paste OS trong src'); h.click('Paste a.ts'); await h.flush()
  h.open(); await h.flush(); h.click('Paste OS trong '); await h.flush()
  assert.deepEqual(e.calls, [['copy', 'a', 'a', file.path, 'src'], ['copy', 'a', 'a', file.path, 'src'], ['os', 'a', '']])
  assert.equal(h.directoryProps().expanded.src, true)
  h.unmount()
})

test('cut subscriptions sync across project tabs and successful same/cross project moves clear cut immediately', async () => {
  for (const target of ['a', 'b']) {
    const e = environment(), source = e.mount(), destination = e.mount(undefined, { projectID: target })
    source.open(file); source.click('Cut src/a.ts'); source.render(); destination.render()
    assert.equal(source.directoryProps().clipboard.mode, 'cut'); assert.equal(destination.directoryProps().clipboard.projectID, 'a')
    destination.open(dir); destination.click('Paste a.ts'); await destination.flush(); source.render()
    assert.equal(source.directoryProps().clipboard, null); assert.equal(destination.directoryProps().clipboard, null)
    assert.deepEqual(e.calls, [['move', target, 'a', file.path, 'src'], target === 'a' ? ['rename', file.path, 'dest/a.ts'] : ['delete', file.path, 'a']])
    source.unmount(); destination.unmount()
  }
})

test('cross-project cut deletes source tabs without clearing the destination selection at the same path', async () => {
  const e = environment(), source = e.mount()
  source.open(file); source.click('Cut src/a.ts'); source.render()
  const destination = e.mount(undefined, { projectID: 'b' })
  destination.open(file); destination.click('Paste a.ts'); await destination.flush()
  assert.deepEqual(e.calls, [['move', 'b', 'a', file.path, 'src'], ['delete', file.path, 'a']])
  assert.equal(destination.directoryProps().selected.path, file.path)
  source.unmount(); destination.unmount()
})

test('same-project delete reports the owning project', async () => {
  const e = environment({ deletePath: async (_project: string, path: string) => ({ path }) }), h = e.mount()
  h.open(file); h.click('Delete src/a.ts'); await h.flush()
  assert.deepEqual(e.calls, [['delete', file.path, 'a']])
  assert.equal(h.directoryProps().selected, null)
  h.unmount()
})

test('delete warns for dirty files and descendants, cancellation preserves them', async () => {
  for (const entry of [file, dir]) for (const accepted of [false, true]) {
    const messages: string[] = [], deleted: string[] = []
    const e = environment({ deletePath: async (_project: string, path: string) => { deleted.push(path); return { path } } }, message => { messages.push(message); return accepted })
    const h = e.mount(undefined, { dirtyPaths: new Set([file.path, 'src-other/safe.ts']) })
    h.open(entry); h.click(`Delete ${entry.path}`); await h.flush()
    assert.equal(messages.length, 1)
    assert.match(messages[0], /src\/a.ts/)
    assert.doesNotMatch(messages[0], /src-other/)
    assert.deepEqual(deleted, accepted ? [entry.path] : [])
    h.unmount()
  }
})

test('scoped Ctrl/Cmd shortcuts use selected files, ignore inputs, and Escape clears cut', async () => {
  const e = environment(), h = e.mount()
  h.open(file); h.key('c'); h.key('v'); await h.flush()
  assert.deepEqual(e.calls, [['copy', 'a', 'a', file.path, 'src']])
  h.key('x', { ctrlKey: false, metaKey: true }); assert.equal(h.directoryProps().clipboard.mode, 'cut')
  h.key('Escape'); assert.equal(h.directoryProps().clipboard, null)
  h.key('x', { target: { closest: () => true } }); assert.equal(h.directoryProps().clipboard, null)
  h.key('v'); await h.flush(); assert.deepEqual(e.calls.at(-1), ['os', 'a', 'src'])
  h.unmount()
})

test('real directory rows select, show cut styling, preserve dragging and stop native context menus', async () => {
  const e = environment(), h = e.mount()
  h.open(file); h.click('Cut src/a.ts'); h.render()
  const rows = e.mount(e.testing.Directory, { ...h.directoryProps(), path: '' }); await rows.flush()
  const row = rows.find(node => node.props.title === file.path && node.props.className?.includes('tree-row'))
  assert.equal(row.props.className, 'tree-row insp-row'); assert.equal(row.props.draggable, true)
  const wrapper = rows.find(node => node.props.className?.startsWith('insp-tree-entry is-selected'))
  assert.match(wrapper.props.className, /is-cut/)
  let prevented = 0, stopped = 0
  wrapper.props.onContextMenu({ clientX: 10, clientY: 20, preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
  assert.equal(prevented, 1); assert.equal(stopped, 1)
  rows.unmount(); h.unmount()
})

test('optional or rejected OS clipboard probes do not break menus', async () => {
  for (const api of [{}, { clipboardFiles: async () => { throw new Error('unavailable') } }]) {
    const e = environment(api), h = e.mount(); h.open(); await h.flush()
    assert.equal(h.label('Paste').props.disabled, true); h.unmount()
  }
})

test('create expands its destination and root context handler suppresses browser menus', async () => {
  const calls: any[][] = []
  const e = environment({ createFile: async (...args: any[]) => { calls.push(args); return { path: 'src/new.ts' } } }), h = e.mount()
  let prevented = 0, stopped = 0
  h.find(node => node.props['data-testid'] === 'explorer').props.onContextMenu({ clientX: 790, clientY: 590, preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
  h.render(); h.label('New File trong ')
  assert.equal(prevented, 1); assert.equal(stopped, 1)
  h.open(dir); h.click('New File trong src'); h.render()
  assert.equal(h.directoryProps().expanded.src, true)
  h.directoryProps().submitName('new.ts'); await h.flush()
  assert.deepEqual(calls, [['a', 'src/new.ts']]); assert.equal(h.directoryProps().naming, null)
  h.unmount()
})

test('no-op moves retain cut state and obsolete OS probe responses cannot enable the current menu', async () => {
  const probes: ((value: any) => void)[] = []
  const e = environment({
    clipboardFiles: () => new Promise(resolve => probes.push(resolve)),
    movePath: async () => ({ from: file.path, to: file.path, sameProject: true, moved: false, directory: false }),
  }), h = e.mount()
  h.open(file); h.click('Cut src/a.ts'); h.render(); h.open(dir); h.click('Paste a.ts'); await h.flush()
  assert.equal(h.directoryProps().clipboard.mode, 'cut')
  assert.deepEqual(e.calls, [])
  h.key('Escape'); h.open(); await h.flush()
  probes[0]({ hasFiles: true }); await h.flush()
  assert.equal(h.label('Paste').props.disabled, true)
  probes.at(-1)!({ hasFiles: true }); await h.flush()
  assert.equal(h.label('Paste').props.disabled, false)
  h.click('Paste'); await h.flush(); assert.deepEqual(e.calls, [['os', 'a', '']])
  h.unmount()
})

test('menu measurement clamps the fixed popover to an eight-pixel viewport margin', () => {
  const e = environment(), h = e.mount()
  h.open(file)
  const menu = h.find(node => node.props.role === 'menu')
  const element = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 292, height: 400 }), querySelector: () => null }
  menu.props.ref.current = element
  h.open(dir)
  assert.equal(element.style.left, '500px'); assert.equal(element.style.top, '192px')
  assert.equal(menu.props.style.position, 'fixed'); assert.equal(menu.props.style.right, 'auto')
  assert.equal(menu.props.style.zIndex, undefined)
  h.unmount()
})

test('menu icons, grouped actions, OS counts and focus restoration match the Explorer contract', async () => {
  const e = environment({ clipboardFiles: async () => ({ hasFiles: true, count: 3, names: ['one', 'two', 'three'] }) }), h = e.mount()
  let focused = 0
  h.find(node => node.props['data-testid'] === 'explorer').props.ref.current = { focus() { focused++ } }
  h.open(file)
  assert.equal(h.directoryProps().menu.kind, 'file')
  assert.ok(nodes(h.label('Cut src/a.ts')).some(node => node.props.name === 'scissors'))
  assert.ok(nodes(h.label('Paste')).some(node => node.props.name === 'clipboard'))
  h.click('Cut src/a.ts'); assert.equal(focused, 1)
  h.open(dir); await h.flush()
  assert.equal(h.directoryProps().menu.kind, 'directory')
  const os = h.label('Paste OS trong src')
  const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
  assert.equal(text(os), 'Dán từ máy (3)')
  assert.equal(nodes(h.find(node => node.props.role === 'menu')).filter(node => node.props.role === 'separator').length, 3)
  h.key('Escape'); assert.equal(focused, 2)
  h.open(); h.key('Escape'); assert.equal(focused, 3)
  h.find(node => node.props.className === 'insp-folder-label').props.onContextMenu({ clientX: 1, clientY: 2, preventDefault() {}, stopPropagation() {} }); h.render()
  assert.equal(h.directoryProps().menu.kind, 'root')
  h.unmount()
})

test('pending move clears shared cut state after unmount without stale project callbacks', async () => {
  let resolve!: (value: any) => void
  const e = environment({ movePath: () => new Promise(value => { resolve = value }) })
  const source = e.mount(), destination = e.mount(undefined, { projectID: 'b' })
  source.open(file); source.click('Cut src/a.ts'); source.render(); destination.render()
  destination.open(dir); destination.click('Paste a.ts'); destination.unmount()
  resolve({ from: file.path, to: 'src/a.ts', sameProject: false, moved: true, directory: false })
  await tick(); source.render()
  assert.equal(source.directoryProps().clipboard, null)
  assert.deepEqual(e.calls, [])
  source.unmount()
})

test('rename rebases selected and clipboard descendants, delete clears them, and sibling prefixes stay intact', async () => {
  const e = environment({
    renamePath: async (_project: string, from: string, to: string) => ({ from, to }),
    deletePath: async (_project: string, path: string) => ({ path }),
  }), h = e.mount()
  h.open(file); h.click('Copy src/a.ts'); h.open(dir); h.click('Rename src'); h.render()
  h.directoryProps().select(file); h.render()
  h.directoryProps().submitName('lib'); await h.flush()
  assert.equal(h.directoryProps().selected.path, 'lib/a.ts')
  assert.equal(h.directoryProps().selected.name, 'a.ts')
  assert.equal(h.directoryProps().clipboard.path, 'lib/a.ts')
  h.key('c'); assert.equal(h.directoryProps().clipboard.path, 'lib/a.ts')
  h.open({ path: 'lib', name: 'lib', directory: true }); h.directoryProps().select({ path: 'library/a.ts', name: 'a.ts', directory: false }); h.render()
  h.click('Delete lib'); await h.flush()
  assert.equal(h.directoryProps().selected.path, 'library/a.ts'); assert.equal(h.directoryProps().clipboard, null)
  h.open(dir); h.directoryProps().select(file); h.render(); h.click('Delete src'); await h.flush()
  assert.equal(h.directoryProps().selected, null)
  h.unmount()
})

test('same-project move updates the selected path before subsequent copy shortcuts', async () => {
  const e = environment(), h = e.mount()
  h.open(file); h.click('Cut src/a.ts'); h.render(); h.key('v'); await h.flush()
  assert.equal(h.directoryProps().selected.path, 'dest/a.ts')
  h.key('c'); assert.equal(h.directoryProps().clipboard.path, 'dest/a.ts')
  h.unmount()
})

test('keyboard focus selects rows and more controls before scoped cut shortcuts', async () => {
  const e = environment(), h = e.mount()
  h.open(file)
  const rows = e.mount(e.testing.Directory, { ...h.directoryProps(), path: '' }); await rows.flush()
  rows.find(node => node.props.title === 'src' && node.props.className === 'tree-row insp-row').props.onFocus()
  h.render(); h.key('x'); assert.equal(h.directoryProps().clipboard.path, 'src')
  rows.label('Thao tác src/a.ts').props.onFocus()
  h.render(); h.key('x'); assert.equal(h.directoryProps().clipboard.path, file.path)
  rows.unmount(); h.unmount()
})

test('OS clipboard metadata updates measure the menu without resetting keyboard focus', async () => {
  let resolve!: (value: any) => void
  const e = environment({ clipboardFiles: () => new Promise(value => { resolve = value }) }), h = e.mount()
  let focused = 0
  const popover = { style: {}, getBoundingClientRect: () => ({ width: 292, height: 400 }), querySelector: () => ({ focus() { focused++ } }) }
  h.open(file); h.find(node => node.props.role === 'menu').props.ref.current = popover
  h.open(dir); assert.equal(focused, 1)
  await tick(); resolve({ hasFiles: true, names: ['one'], count: 1 }); await h.flush()
  assert.equal(focused, 1)
  h.unmount()
})
