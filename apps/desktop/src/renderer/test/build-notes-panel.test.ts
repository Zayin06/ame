import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript'
import type { BuildNotesPreview, BuildNotesRequest, BuildNotesResult, GitCommitSummary } from '../../../../../packages/protocol/src/index'
import type { BuildNotesPanelProps } from '../components/BuildNotesPanel'
import { FileTypeIcon } from '../components/FileTypeIcon'
import { Icon } from '../components/Icon'
import { MessageContent } from '../components/MessageContent'
import * as buildUI from '../build-notes-ui'
import * as gitUI from '../git-ui'

const first: GitCommitSummary = { hash: 'abcdef123', shortHash: 'abcdef1', subject: 'feat: checkout', body: 'Payment flow', author: 'Alice', date: '2026-11-23T00:00:00Z', refs: [] }
const second: GitCommitSummary = { ...first, hash: '987654321', shortHash: '9876543', subject: 'fix: layout', body: '', author: 'Bob' }
const preview: BuildNotesPreview = {
  branch: 'main', commitCount: 2, commits: [first, second], workingFileCount: 1, additions: 8, deletions: 3, truncated: true,
  files: [{ path: 'checkout.ts', status: 'M', additions: 8, deletions: 3, source: 'both' }], skill: 'qc-build', effectiveModelID: 'test-model',
}
const result: BuildNotesResult = { notes: '# Build\n- **Checkout** with `checkout.ts`', truncated: true, commitCount: 2, fileCount: 1, workingFileCount: 1, modelID: 'test-model', skill: 'qc-build' }
const base: BuildNotesPanelProps = { projectID: 'project', connected: true, generation: 0, git: { branch: 'main', changes: [{ path: 'checkout.ts', index: 'M', working: ' ' }] }, onDiff() {} }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

function harness(extra: Partial<BuildNotesPanelProps> = {}, api: Record<string, unknown> = {}, clipboard?: (value: string) => Promise<void>) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, writes = 0, tree: ReactNode, props = { ...base, ...extra }
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: unknown) => { writes++; slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectIndex++, old = effects[index]
      if (!old || deps.length !== old.deps.length || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
      }
    },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const source = readFileSync(new URL('../components/BuildNotesPanel.tsx', import.meta.url), 'utf8')
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText
  const modules: Record<string, unknown> = { react: hooks, './Icon': { Icon }, './FileTypeIcon': { FileTypeIcon }, './MessageContent': { MessageContent }, '../build-notes-ui': buildUI, '../git-ui': gitUI }
  const copied: string[] = [], timers = new Map<number, () => void>()
  let timerID = 0
  runInNewContext(code, {
    exports, window: { ame: { gitLog: async () => [first, second], buildNotesPreview: async () => preview, generateBuildNotes: async () => result, ...api } },
    navigator: { clipboard: { writeText: clipboard ?? (async (value: string) => { copied.push(value) }) } },
    setTimeout(fn: () => void) { timers.set(++timerID, fn); return timerID }, clearTimeout(id: number) { timers.delete(id) },
    require: (name: string) => modules[name] ?? nativeRequire(name),
  })
  const Component = exports.BuildNotesPanel as (props: BuildNotesPanelProps) => ReactNode
  function render(next: Partial<BuildNotesPanelProps> = {}) {
    props = { ...props, ...next }; cursor = 0; effectIndex = 0; tree = Component(props)
    pending.splice(0).forEach(run => run())
    return renderToStaticMarkup(tree)
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    return [node, ...all(node.props.children as ReactNode)]
  }
  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) {
    const node = all(tree).find(predicate); assert.ok(node, 'expected rendered control'); return node
  }
  const byID = (id: string) => find(node => node.props['data-testid'] === id)
  function invoke(node: ReactElement<Record<string, unknown>>, event = 'onClick', value?: unknown) {
    assert.notEqual(node.props.disabled, true)
    return (node.props[event] as (value?: unknown) => unknown)(value)
  }
  function change(node: ReactElement<Record<string, unknown>>, value: string | boolean) { return invoke(node, 'onChange', { target: { value, checked: value } }) }
  return {
    render, find, byID, invoke, change, copied,
    click(label: string) { return invoke(find(node => node.type === 'button' && text(node) === label)) },
    async flush() { let html = ''; for (let i = 0; i < 4; i++) { await tick(); html = render() } return html },
    expireCopy() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(run => run()) },
    unmount() { effects.forEach(effect => effect.cleanup?.()); assert.equal(timers.size, 0) },
    get writes() { return writes },
  }
}

test('range scope loads current-branch commits, previews stats/config and opens changed-file diffs', async () => {
  const requests: BuildNotesRequest[] = [], logs: unknown[][] = [], diffs: string[] = []
  const h = harness({ onDiff(path) { diffs.push(path) } }, {
    async gitLog(...args: unknown[]) { logs.push(args); return [first, second] },
    async buildNotesPreview(_id: string, request: BuildNotesRequest) { requests.push(request); return preview },
  })
  assert.match(h.render(), /Chọn phạm vi thay đổi/)
  const html = await h.flush()
  assert.deepEqual(logs, [['project', 50]])
  assert.match(html, /main/); assert.match(html, /abcdef1 — feat: checkout/)
  assert.match(html, /2 commit · 1 tệp · 1 tệp chưa commit · \+8 -3/)
  assert.match(html, /Skill: \/qc-build · Model: test-model/); assert.match(html, /Diff đã được rút gọn/)
  h.change(h.byID('build-notes-base-select'), first.hash); await h.flush()
  h.change(h.byID('build-notes-include-working'), false); await h.flush()
  assert.deepEqual(plain(requests.at(-1)), { mode: 'range', baseCommit: first.hash, includeWorking: false })
  h.invoke(h.find(node => node.type === 'button' && text(node).startsWith('checkout.ts')))
  assert.deepEqual(diffs, ['checkout.ts'])
  h.render({ connected: false }); assert.equal(h.byID('build-notes-generate-btn').props.disabled, true)
  h.unmount()
})

test('specific commits support author/hash/subject filtering, multiselect, deselect and clearing', async () => {
  const requests: BuildNotesRequest[] = []
  const h = harness({}, { async buildNotesPreview(_id: string, request: BuildNotesRequest) { requests.push(request); return preview } })
  h.render(); await h.flush(); h.click('Chọn lẻ commit'); h.render()
  const checkbox = (hash: string) => h.find(node => node.type === 'li' && text(node).startsWith(hash)).props.children as ReactElement<{ children: ReactNode[] }>
  const select = (hash: string, checked: boolean) => {
    const label = checkbox(hash)
    h.change((label.props.children as ReactElement<Record<string, unknown>>[])[0], checked)
  }
  select(first.shortHash, true); h.render(); select(second.shortHash, true); await h.flush()
  assert.deepEqual(plain(requests.at(-1)), { mode: 'commits', commitHashes: [first.hash, second.hash], includeWorking: true })
  const filter = () => h.find(node => node.props['aria-label'] === 'Lọc commit')
  for (const query of ['bOB', second.shortHash, 'layout']) {
    h.change(filter(), query); const html = h.render()
    assert.match(html, /fix: layout/); assert.doesNotMatch(html, /feat: checkout/)
  }
  select(second.shortHash, false); await h.flush()
  assert.deepEqual(plain(requests.at(-1)?.commitHashes), [first.hash])
  h.click('Bỏ chọn tất cả'); await h.flush()
  assert.deepEqual(plain(requests.at(-1)?.commitHashes), [])
  assert.equal(h.find(node => node.type === 'button' && text(node) === 'Bỏ chọn tất cả').props.disabled, true)
  h.unmount()
})

test('file diffs use the resolved preview commit, range or commit-set scope and leave working files unscoped', async () => {
  for (const scenario of [
    { mode: 'range', source: 'committed', commits: [first], baseCommit: second.hash, includeWorking: true, target: { kind: 'commit', commit: first.hash } },
    { mode: 'range', source: 'both', commits: [first, second], baseCommit: first.hash, includeWorking: true, target: { kind: 'range', baseCommit: first.hash, includeWorking: true } },
    { mode: 'range', source: 'committed', commits: [first, second], baseCommit: first.hash, includeWorking: true, target: { kind: 'range', baseCommit: first.hash, includeWorking: false } },
    { mode: 'range', source: 'both', commits: [first, second], baseCommit: first.hash, includeWorking: false, target: { kind: 'range', baseCommit: first.hash, includeWorking: false } },
    { mode: 'commits', source: 'both', commits: [first, second], includeWorking: true, target: { kind: 'commits', commits: [first.hash, second.hash], includeWorking: true } },
    { mode: 'commits', source: 'committed', commits: [first, second], includeWorking: true, target: { kind: 'commits', commits: [first.hash, second.hash], includeWorking: false } },
    { mode: 'range', source: 'both', commits: [first, second], includeWorking: false, target: { kind: 'commits', commits: [first.hash, second.hash], includeWorking: false } },
    { mode: 'range', source: 'working', commits: [first], baseCommit: second.hash, includeWorking: true, target: undefined },
    { mode: 'range', source: 'working', commits: [], includeWorking: true, target: undefined },
    { mode: 'range', source: 'committed', commits: [], includeWorking: false, target: undefined },
  ] as const) {
    const diffs: { path: string; target: unknown; argumentCount: number }[] = []
    const h = harness({ onDiff(...args) { diffs.push({ path: args[0], target: args[1], argumentCount: args.length }) } }, {
      async buildNotesPreview() { return { ...preview, commits: [...scenario.commits], commitCount: scenario.commits.length, files: [{ ...preview.files[0], source: scenario.source }] } },
    })
    try {
      h.render(); await h.flush()
      if (scenario.mode === 'commits') { h.click('Chọn lẻ commit'); h.render() }
      else if ('baseCommit' in scenario && scenario.baseCommit) { h.change(h.byID('build-notes-base-select'), scenario.baseCommit); h.render() }
      h.change(h.byID('build-notes-include-working'), scenario.includeWorking); await h.flush()
      h.invoke(h.find(node => node.type === 'button' && text(node).startsWith('checkout.ts')))
      assert.equal(diffs.length, 1)
      assert.equal(diffs[0].path, 'checkout.ts')
      assert.deepEqual(diffs[0].target === undefined ? undefined : plain(diffs[0].target), scenario.target)
      assert.equal(diffs[0].argumentCount, scenario.target === undefined ? 1 : 2)
    } finally { h.unmount() }
  }
})

test('generation is one-shot, forwards context, supports editable Markdown, preview/file callbacks and both copy formats', async () => {
  const pending = deferred<BuildNotesResult>(), requests: BuildNotesRequest[] = [], opened: unknown[][] = []
  const h = harness({ onOpenFile(...args) { opened.push(args) } }, {
    generateBuildNotes(id: string, request: BuildNotesRequest) { assert.equal(id, 'project'); requests.push(request); return pending.promise },
  })
  h.render(); await h.flush()
  h.change(h.byID('build-notes-extra-note'), '  Staging v1.2  '); h.render()
  const generate = h.byID('build-notes-generate-btn')
  h.invoke(generate); h.invoke(generate)
  assert.equal(requests.length, 1); assert.equal(requests[0].note, 'Staging v1.2')
  assert.match(h.render(), /Đang tạo mô tả…/)
  assert.equal(h.byID('build-notes-base-select').props.disabled, true)
  pending.resolve(result); let html = await h.flush()
  assert.match(html, /chat-markdown/); assert.match(html, /<h1>Build<\/h1>/)
  assert.match(html, /Model: test-model/); assert.match(html, /Skill: \/qc-build/)
  const message = h.find(node => node.type === MessageContent)
  ;(message.props.onOpenFile as (path: string, line?: number) => void)('checkout.ts', 3)
  assert.deepEqual(opened, [['checkout.ts', 3]])
  h.click('Chỉnh sửa'); h.render()
  h.change(h.byID('build-notes-result-editor'), '# Edited\n- **Ready** and `checkout.ts`'); h.render()
  h.invoke(h.byID('build-notes-copy-md')); await h.flush()
  h.invoke(h.byID('build-notes-copy-plain')); html = await h.flush()
  assert.deepEqual(h.copied, ['# Edited\n- **Ready** and `checkout.ts`', 'Edited\n- Ready and checkout.ts'])
  assert.match(html, /role="status">Đã sao chép/)
  h.expireCopy(); assert.doesNotMatch(h.render(), /Đã sao chép/)
  h.click('Xem trước'); html = h.render(); assert.match(html, /<h1>Edited<\/h1>/)
  h.render({ generation: 1 }); html = await h.flush()
  assert.match(html, /<h1>Edited<\/h1>/); assert.equal(requests.length, 1)
  h.unmount()
})

test('failed regeneration preserves edited notes and formats the error; cancellation stays silent', async () => {
  let count = 0
  const h = harness({}, { async generateBuildNotes() { if (++count === 1) return result; throw new Error(count === 2 ? 'EMPTY_BUILD_NOTES' : 'CANCELLED') } })
  h.render(); await h.flush(); h.invoke(h.byID('build-notes-generate-btn')); await h.flush()
  h.click('Chỉnh sửa'); h.render(); h.change(h.byID('build-notes-result-editor'), 'Keep this draft'); h.render()
  h.invoke(h.byID('build-notes-generate-btn')); let html = await h.flush()
  assert.match(html, /role="alert"/); assert.ok(html.includes(buildUI.formatBuildNotesError(new Error('EMPTY_BUILD_NOTES')).title))
  assert.equal(h.byID('build-notes-result-editor').props.value, 'Keep this draft')
  h.invoke(h.byID('build-notes-generate-btn')); html = await h.flush()
  assert.doesNotMatch(html, /role="alert"/); assert.match(html, /Keep this draft/)
  h.unmount()
})

for (const boundary of ['project', 'generation', 'unmount'] as const) {
  test(`ignores stale preview, log and generation completions after ${boundary}`, async () => {
    const oldPreview = deferred<BuildNotesPreview>(), oldResult = deferred<BuildNotesResult>(), oldLog = deferred<GitCommitSummary[]>()
    let previews = 0, logs = 0
    const h = harness({}, {
      gitLog() { return ++logs === 1 ? oldLog.promise : Promise.resolve([second]) },
      buildNotesPreview() { return ++previews === 1 ? oldPreview.promise : Promise.resolve({ ...preview, skill: 'current', commitCount: 0 }) },
      generateBuildNotes() { return oldResult.promise },
    })
    h.render(); h.render(); h.invoke(h.byID('build-notes-generate-btn')); h.render()
    if (boundary === 'unmount') h.unmount()
    else { h.render(boundary === 'project' ? { projectID: 'other' } : { generation: 1 }); await h.flush() }
    const writes = h.writes
    oldPreview.resolve({ ...preview, skill: 'stale' }); oldResult.resolve({ ...result, notes: 'STALE NOTES' }); oldLog.resolve([first]); await tick()
    assert.equal(h.writes, writes)
    if (boundary !== 'unmount') {
      const html = h.render()
      assert.doesNotMatch(html, /STALE NOTES|Skill: \/stale|feat: checkout/)
      assert.equal(h.byID('build-notes-generate-btn').props.disabled, false)
      h.unmount()
    }
  })
}

test('latest scope preview wins; project changes reset drafts and selections while refresh prunes missing commits', async () => {
  const pending = deferred<BuildNotesPreview>()
  let previews = 0, logs = 0, consumed = 0
  const h = harness({ initialBaseCommit: first.hash, onConsumeInitialBase() { consumed++ } }, {
    async gitLog() { return ++logs > 1 ? [second] : [first, second] },
    buildNotesPreview() { return ++previews === 1 ? pending.promise : Promise.resolve(preview) },
  })
  h.render(); await h.flush()
  assert.equal(consumed, 1); assert.equal(h.byID('build-notes-base-select').props.value, first.hash)
  h.render({ initialBaseCommit: undefined })
  pending.resolve({ ...preview, skill: 'stale-scope' }); await tick()
  assert.doesNotMatch(h.render(), /stale-scope/)
  h.change(h.byID('build-notes-extra-note'), 'context'); h.render()
  h.invoke(h.byID('build-notes-generate-btn')); await h.flush()
  h.render({ generation: 1 }); await h.flush()
  assert.equal(h.byID('build-notes-base-select').props.value, '')
  assert.equal(h.byID('build-notes-extra-note').props.value, 'context')
  h.click('Chọn lẻ commit'); h.render()
  h.change(h.find(node => node.props['aria-label'] === 'Lọc commit'), 'Bob'); h.render()
  h.change(h.byID('build-notes-include-working'), false); h.render()
  h.render({ projectID: 'other' }); const html = await h.flush()
  assert.equal(h.byID('build-notes-base-select').props.value, '')
  assert.equal(h.byID('build-notes-extra-note').props.value, '')
  assert.equal(h.byID('build-notes-include-working').props.checked, true)
  assert.doesNotMatch(html, /chat-markdown|role="alert"/)
  h.unmount()
})

test('empty preview disables generation and default config is visible; cancelled preview and clipboard failures are handled', async () => {
  const h = harness({}, { async buildNotesPreview() { return { ...preview, skill: undefined, effectiveModelID: undefined, files: [], commitCount: 0 } } })
  h.render(); const html = await h.flush()
  assert.equal(h.byID('build-notes-generate-btn').props.disabled, true)
  assert.match(html, /Skill: Mặc định QC · Model: default/)
  h.unmount()
  const cancelled = harness({}, { async buildNotesPreview() { throw new Error('CANCELLED') } }, async () => { throw new Error('Clipboard denied') })
  cancelled.render(); assert.doesNotMatch(await cancelled.flush(), /role="alert"/)
  cancelled.invoke(cancelled.byID('build-notes-generate-btn')); await cancelled.flush()
  cancelled.invoke(cancelled.byID('build-notes-copy-md'))
  assert.match(await cancelled.flush(), /Clipboard denied/)
  cancelled.unmount()
})
