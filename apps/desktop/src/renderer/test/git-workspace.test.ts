import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript'
import type { GitCommitSummary, GitStashEntry } from '../../../../../packages/protocol/src/index'
import { GitWorkspace, type GitWorkspaceProps } from '../components/GitWorkspace'
import { FileTypeIcon } from '../components/FileTypeIcon'
import { Icon } from '../components/Icon'
import * as primitives from '../components/Primitives'
import type { Inspector } from '../components/Inspector'
import { BuildNotesPanel } from '../components/BuildNotesPanel'
import { ProjectSearch } from '../components/ProjectSearch'
import * as gitUI from '../git-ui'
import * as scm from '../scm-commit'

const base: GitWorkspaceProps = {
  projectID: 'project', projectName: 'Demo', connected: true, generation: 0, activeTab: 'commit',
  git: { branch: 'main', tracking: 'origin/main', hasRemote: true, ahead: 2, behind: 1, changes: [
    { path: 'staged.ts', index: 'M', working: ' ' }, { path: 'new.ts', index: '?', working: '?' },
  ] },
  gitError: '', message: 'feat: draft', amend: false, noVerify: false, commitEnhanceSkill: '',
  onSelectTab() {}, onMessageChange() {}, onAmendChange() {}, onNoVerifyChange() {}, onDiff() {}, onClose() {}, refresh() {},
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

// Run real effects and handlers with controlled props, without a DOM dependency.
function harness(extra: Partial<GitWorkspaceProps> = {}, api: Record<string, unknown> = {}) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = []
  const pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, writes = 0, tree: ReactNode
  let props = { ...base, ...extra }
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: unknown) => { writes++; slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectIndex++, old = effects[index]
      if (!old || deps.length !== old.deps.length || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
      }
    },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const source = readFileSync(new URL('../components/GitWorkspace.tsx', import.meta.url), 'utf8')
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText
  const modules: Record<string, unknown> = { react: hooks, './BuildNotesPanel': { BuildNotesPanel }, './Icon': { Icon }, './FileTypeIcon': { FileTypeIcon }, '../git-ui': gitUI, '../scm-commit': scm }
  const window = { ame: { gitStashList: async () => [], gitLog: async () => [], ...api } }
  runInNewContext(code, { exports, window, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Component = exports.GitWorkspace as (props: GitWorkspaceProps) => ReactNode
  function render(next: Partial<GitWorkspaceProps> = {}) {
    props = { ...props, ...next }; cursor = 0; effectIndex = 0
    tree = Component({
      ...props,
      onMessageChange(value) { props = { ...props, message: value }; extra.onMessageChange?.(value) },
      onAmendChange(value) { props = { ...props, amend: value }; extra.onAmendChange?.(value) },
      onNoVerifyChange(value) { props = { ...props, noVerify: value }; extra.onNoVerifyChange?.(value) },
      onSelectTab(value) { props = { ...props, activeTab: value }; extra.onSelectTab?.(value) },
    })
    pending.splice(0).forEach(run => run())
    return renderToStaticMarkup(tree)
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    return [node, ...all(node.props.children as ReactNode)]
  }
  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) {
    const found = all(tree).find(predicate)
    assert.ok(found, 'expected rendered control')
    return found
  }
  function byID(id: string) { return find(node => node.props['data-testid'] === id) }
  function invoke(node: ReactElement<Record<string, unknown>>, event = 'onClick', value?: unknown) {
    assert.notEqual(node.props.disabled, true, `control ${text(node)} must be enabled`)
    return (node.props[event] as (value?: unknown) => unknown)(value)
  }
  function click(label: string) { return invoke(find(node => node.type === 'button' && text(node) === label)) }
  function change(label: string, value: string | boolean) {
    const node = find(item => item.props['aria-label'] === label || item.props.placeholder === label || (item.type === 'label' && text(item) === label))
    const input = node.type === 'label' ? all(node).find(item => item.type === 'input')! : node
    return invoke(input, 'onChange', { target: { value, checked: value } })
  }
  return {
    render, find, byID, invoke, click, change,
    async flush() { let html = ''; for (let i = 0; i < 3; i++) { await tick(); html = render() } return html },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
    get writes() { return writes },
    get props() { return props },
  }
}

const first: GitCommitSummary = { hash: 'abcdef123', shortHash: 'abcdef1', subject: 'feat: first', body: 'Full body', author: 'Alice', date: '2026-11-23T00:00:00Z', refs: ['HEAD -> main'] }
const second: GitCommitSummary = { ...first, hash: '987654321', shortHash: '9876543', subject: 'fix: second', body: '', author: 'Bob', refs: [] }
const stash: GitStashEntry = { index: 0, oid: 'a'.repeat(40), ref: 'stash@{0}', branch: 'main', message: 'saved work', date: first.date }

test('header renders accessible workspace, branch/sync badges and close callback', async () => {
  const html = renderToStaticMarkup(createElement(GitWorkspace, base))
  assert.match(html, /<main data-testid="git-workspace" class="git-workspace" data-region="Git Workspace">/)
  assert.match(html, /← Quay lại Chat/)
  assert.match(html, /Demo/); assert.match(html, /main/); assert.match(html, /origin\/main/)
  assert.match(html, /↑2 ↓1/); assert.match(html, /Pull ↓1/); assert.match(html, /Push ↑2/)
  assert.match(html, /role="tablist"/)
  let closed = 0
  const h = harness({ onClose() { closed++ } })
  h.render(); h.invoke(h.byID('git-workspace-close')); assert.equal(closed, 1)
  h.render({ git: { ...base.git!, hasRemote: false } })
  assert.equal(h.find(node => node.type === 'button' && text(node) === 'Fetch').props.disabled, true)
  h.unmount()
})

test('Build Notes fourth tab and History shortcut forward the base once and reset only on project changes', async () => {
  const diffs: string[] = [], opened: string[] = [], tabs: string[] = []
  const h = harness({ activeTab: 'history', onDiff(path) { diffs.push(path) }, onOpenFile(path) { opened.push(path) }, onSelectTab(tab) { tabs.push(tab) } }, {
    async gitLog() { return [first, second] },
  })
  h.render(); await h.flush()
  const tab = h.find(node => node.props.id === 'git-workspace-tab-build-notes')
  assert.equal(tab.props.role, 'tab'); assert.equal(text(tab), 'Build Notes')
  h.invoke(tab); h.render()
  assert.equal(h.find(node => node.type === BuildNotesPanel).props.initialBaseCommit, undefined)
  h.render({ activeTab: 'history' }); await h.flush()
  h.click('Build Notes từ mốc này'); h.render()
  assert.equal(h.props.activeTab, 'build-notes')
  h.render({ generation: 1 })
  let panel = h.find(node => node.type === BuildNotesPanel)
  assert.equal(panel.props.initialBaseCommit, first.hash)
  assert.equal(panel.props.projectID, 'project'); assert.equal(panel.props.generation, 1)
  ;(panel.props.onDiff as (path: string) => void)('sample.ts')
  ;(panel.props.onOpenFile as (path: string) => void)('open.ts')
  assert.deepEqual(diffs, ['sample.ts']); assert.deepEqual(opened, ['open.ts'])
  ;(panel.props.onConsumeInitialBase as () => void)(); h.render()
  assert.equal(h.find(node => node.type === BuildNotesPanel).props.initialBaseCommit, undefined)
  h.render({ activeTab: 'history' }); await h.flush(); h.click('Build Notes từ mốc này'); h.render()
  h.render({ projectID: 'other' }); h.render()
  panel = h.find(node => node.type === BuildNotesPanel)
  assert.equal(panel.props.initialBaseCommit, undefined)
  assert.ok(tabs.every(value => value === 'build-notes'))
  h.unmount()
})

test('Enhance updates the controlled message, counter and skill; blocks concurrent operations', async () => {
  const request = deferred<{ message: string }>()
  let calls = 0
  const h = harness({ commitEnhanceSkill: 'team-commit' }, { generateCommitMessage(id: string) { assert.equal(id, 'project'); calls++; return request.promise } })
  h.render(); await h.flush()
  const enhance = h.byID('git-workspace-enhance-btn')
  h.invoke(enhance); h.invoke(enhance)
  assert.equal(calls, 1)
  assert.match(h.render(), /amekit-spinner/)
  assert.equal(h.byID('git-workspace-enhance-btn').props['aria-busy'], true)
  assert.equal(h.byID('git-workspace-commit-btn').props.disabled, true)
  request.resolve({ message: 'x'.repeat(73) + '\n\nbody' })
  const html = await h.flush()
  assert.equal(h.byID('git-workspace-commit-input').props.value, 'x'.repeat(73) + '\n\nbody')
  assert.match(html, /git-composer__counter is-over/); assert.match(html, /Tiêu đề: 73\/72/); assert.match(html, /3 dòng/); assert.match(html, /\/ team-commit/)
  h.change('Thông điệp commit mở rộng', 'short'); assert.doesNotMatch(h.render(), /counter is-over/)
  h.click('Xóa nội dung'); h.render(); assert.equal(h.props.message, '')
  h.render({ connected: false }); assert.equal(h.byID('git-workspace-enhance-btn').props.disabled, true)
  h.render({ connected: true, git: { branch: 'main', changes: [] } }); assert.equal(h.byID('git-workspace-enhance-btn').props.disabled, true)
  h.unmount()
})

test('Commit Agent opens for unstaged changes and respects connection, busy state and callback availability', async () => {
  let opened = 0
  const request = deferred<{ message: string }>()
  const h = harness({ onOpenCommitAgent() { opened++ } }, { generateCommitMessage() { return request.promise } })
  try {
    h.render(); await h.flush()
    const id = 'git-workspace-commit-agent-btn'
    assert.equal(h.byID(id).props.disabled, false)
    h.invoke(h.byID(id)); assert.equal(opened, 1)
    h.invoke(h.byID('git-workspace-enhance-btn')); h.render()
    assert.equal(h.byID(id).props.disabled, true)
    request.resolve({ message: 'feat: generated' }); await h.flush()
    h.render({ git: { branch: 'main', changes: [{ path: 'unstaged.ts', index: ' ', working: 'M' }] } })
    assert.equal(h.byID(id).props.disabled, false)
    assert.equal(h.byID('git-workspace-enhance-btn').props.disabled, true)
    h.invoke(h.byID(id)); assert.equal(opened, 2)
    h.render({ connected: false }); assert.equal(h.byID(id).props.disabled, true)
    h.render({ connected: true, onOpenCommitAgent: undefined }); assert.equal(h.byID(id).props.disabled, true)
    h.render({ onOpenCommitAgent() {}, git: { branch: 'main', changes: [] } }); assert.equal(h.byID(id).props.disabled, true)
  } finally { h.unmount() }
})

test('Enhance tooltip explains readiness, active configuration and every disabled state', async () => {
  const request = deferred<{ message: string }>()
  const h = harness({ commitEnhanceSkill: 'team-commit', commitEnhanceModel: 'haiku' }, { generateCommitMessage() { return request.promise } })
  const title = () => String(h.byID('git-workspace-enhance-btn').props.title)
  try {
    h.render(); await h.flush()
    assert.match(title(), /Skill \/team-commit/)
    assert.match(title(), /Model: haiku/)
    h.render({ connected: false }); assert.match(title(), /Chưa kết nối/)
    h.render({ connected: true, git: { branch: 'main', changes: [] } }); assert.match(title(), /Stage ít nhất một tệp/)
    h.render({ git: base.git }); h.invoke(h.byID('git-workspace-enhance-btn')); h.render()
    assert.match(title(), /Đang xử lý/)
    request.resolve({ message: 'feat: ready' }); await h.flush()
    h.render({ commitEnhanceSkill: 'updated-skill', commitEnhanceModel: 'sonnet' })
    assert.match(title(), /Skill \/updated-skill/); assert.match(title(), /Model: sonnet/)
    h.render({ commitEnhanceSkill: '', commitEnhanceModel: '' })
    assert.match(title(), /thay đổi đã stage/)
    assert.doesNotMatch(title(), /Skill|Model:/)
  } finally { h.unmount() }
})

test('installed Enhance settings refresh on both account and bundle changes', () => {
  for (const path of ['../App.tsx', '../components/Inspector.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const installedIndex = source.indexOf("account?.('installed', {})")
    assert.ok(installedIndex >= 0, `${path} reads installed features`)
    const installedEffect = source.slice(installedIndex, source.indexOf('}, [projectID', installedIndex))
    for (const event of ['ame-account-changed', 'ame-bundle-updated']) {
      assert.ok(installedEffect.includes(`window.addEventListener('${event}', load)`), `${path} listens for ${event}`)
      assert.ok(installedEffect.includes(`window.removeEventListener('${event}', load)`), `${path} cleans up ${event}`)
    }
  }
})

test('Commit and Commit & Push forward options, clear message and refresh in order', async () => {
  for (const push of [false, true]) {
    const calls: unknown[][] = []
    let refreshes = 0
    const h = harness({ amend: true, noVerify: true, refresh() { refreshes++ } }, {
      async commit(...args: unknown[]) { calls.push(['commit', ...args]) },
      async gitPush(...args: unknown[]) { calls.push(['push', ...args]); return { summary: 'pushed' } },
    })
    h.render(); await h.flush()
    h.invoke(h.byID(push ? 'git-workspace-commit-push-btn' : 'git-workspace-commit-btn'))
    const html = await h.flush()
    assert.deepEqual(plain(calls), push ? [['commit', 'project', 'feat: draft', { amend: true, noVerify: true }], ['push', 'project']] : [['commit', 'project', 'feat: draft', { amend: true, noVerify: true }]])
    assert.equal(h.props.message, ''); assert.equal(h.props.amend, false)
    assert.equal(refreshes, 1); assert.match(html, /Hoàn tất/)
    h.unmount()
  }
})

test('commit errors are formatted, failed commits do not push, and push failures preserve completed commit state', async () => {
  for (const failPush of [false, true]) {
    let pushes = 0
    const h = harness({ amend: true, refresh() { h.render({ generation: h.props.generation + 1 }) } }, {
      async commit() { if (!failPush) throw new Error('pre-commit hook failed') },
      async gitPush() { assert.equal(h.props.amend, false); pushes++; throw new Error('GIT_PUSH_REJECTED_NON_FF') },
    })
    h.render(); await h.flush(); h.invoke(h.byID('git-workspace-commit-push-btn'))
    const html = await h.flush()
    assert.match(html, /role="alert"/)
    assert.ok(html.includes(gitUI.formatGitError(new Error(failPush ? 'GIT_PUSH_REJECTED_NON_FF' : 'pre-commit hook failed')).title))
    assert.equal(pushes, failPush ? 1 : 0); assert.equal(h.props.message, failPush ? '' : 'feat: draft')
    assert.equal(h.props.amend, !failPush)
    assert.equal(h.props.generation, 1)
    assert.doesNotMatch(html, /Hoàn tất/)
    h.unmount()
  }
})

for (const action of ['Commit', 'Pull', 'Lưu Stash'] as const) {
  test(`${action} preserves notices and view state across generation refreshes, but not project switches`, async () => {
    const calls: unknown[][] = []
    const h = harness({ refresh() { h.render({ generation: h.props.generation + 1 }) } }, {
      async commit() { calls.push(['commit']) },
      async gitPull() { calls.push(['pull']); return { summary: 'Pulled' } },
      async gitStashPush(...args: unknown[]) { calls.push(['stash', ...args]) },
      async gitLog(id: string) { calls.push(['log', id]); return [first, second] },
      async gitStashList(id: string) { calls.push(['list', id]); return id === 'project' ? [stash] : [] },
      async gitCommitDetail(id: string, hash: string) {
        calls.push(['detail', id, hash])
        return { ...first, files: [], patch: 'selected patch' }
      },
    })
    h.render({ activeTab: 'history' }); await h.flush()
    h.change('Tìm commit', 'Alice'); h.render()
    h.invoke(h.find(node => node.type === 'button' && text(node).startsWith(first.shortHash)))
    await h.flush()
    h.render({ activeTab: 'stash' }); await h.flush()
    h.change('Thông điệp stash', 'saved draft')
    h.change('Gồm tệp mới (untracked)', false); h.render()
    if (action === 'Commit') {
      h.render({ activeTab: 'commit' }); h.invoke(h.byID('git-workspace-commit-btn'))
    } else if (action === 'Pull') h.click('Pull ↓1')
    else h.invoke(h.find(node => node.type === 'form'), 'onSubmit', { preventDefault() {} })
    let html = await h.flush()
    assert.equal(h.props.generation, 1)
    assert.match(html, new RegExp(`${action}: Hoàn tất`))
    assert.match(html, /Stash \(1\)/)
    h.render({ activeTab: 'stash' }); await h.flush()
    // Saving a stash consumes its message; refreshing must not clear a subsequent draft.
    assert.equal(h.find(node => node.props['aria-label'] === 'Thông điệp stash').props.value, action === 'Lưu Stash' ? '' : 'saved draft')
    if (action === 'Lưu Stash') {
      assert.deepEqual(plain(calls.find(call => call[0] === 'stash')), ['stash', 'project', 'saved draft', false])
      h.change('Thông điệp stash', 'next draft'); h.render()
    }
    h.render({ generation: 2 }); html = await h.flush()
    assert.match(html, new RegExp(`${action}: Hoàn tất`))
    assert.equal(h.find(node => node.props['aria-label'] === 'Thông điệp stash').props.value, action === 'Lưu Stash' ? 'next draft' : 'saved draft')
    assert.equal(h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, false)
    const detailsBefore = calls.filter(call => call[0] === 'detail').length
    h.render({ activeTab: 'history' }); html = await h.flush()
    assert.equal(h.find(node => node.props['aria-label'] === 'Tìm commit').props.value, 'Alice')
    assert.equal(h.find(node => node.type === 'button' && text(node).startsWith(first.shortHash)).props['aria-pressed'], true)
    assert.doesNotMatch(html, /fix: second/)
    assert.match(html, /selected patch/)
    assert.ok(calls.filter(call => call[0] === 'detail').length > detailsBefore)
    assert.equal(calls.filter(call => call[0] === 'list' && call[1] === 'project').length, 3)
    h.render({ generation: 3 }); html = await h.flush()
    assert.match(html, new RegExp(`${action}: Hoàn tất`))
    assert.equal(h.find(node => node.props['aria-label'] === 'Tìm commit').props.value, 'Alice')
    assert.equal(h.find(node => node.type === 'button' && text(node).startsWith(first.shortHash)).props['aria-pressed'], true)
    assert.match(html, /selected patch/)
    h.render({ projectID: 'other' }); html = await h.flush()
    assert.doesNotMatch(html, /Hoàn tất|selected patch/)
    assert.equal(h.find(node => node.props['aria-label'] === 'Tìm commit').props.value, '')
    assert.equal(h.find(node => node.type === 'button' && text(node).startsWith(first.shortHash)).props['aria-pressed'], false)
    assert.match(html, /fix: second/)
    assert.match(html, /Stash \(0\)/)
    h.render({ activeTab: 'stash' }); await h.flush()
    assert.equal(h.find(node => node.props['aria-label'] === 'Thông điệp stash').props.value, '')
    assert.equal(h.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, true)
    h.unmount()
  })
}

test('undo restores message and refreshes; amend prefill and commit shortcut respect options and clean trees', async () => {
  const calls: unknown[][] = []
  let refreshes = 0, diffs: string[] = []
  const h = harness({ refresh() { refreshes++ }, onDiff(path) { diffs.push(path) } }, {
    async gitUndoLastCommit(id: string) { calls.push(['undo', id]); return { message: 'restored commit' } },
    async gitLog(...args: unknown[]) { calls.push(['log', ...args]); return [first] },
    async commit(...args: unknown[]) { calls.push(['commit', ...args]) },
    async stage(...args: unknown[]) { calls.push(['stage', ...args]) },
    async stageAll(...args: unknown[]) { calls.push(['stageAll', ...args]) },
  })
  h.render(); await h.flush(); h.invoke(h.byID('git-workspace-undo-commit-btn')); await h.flush()
  assert.equal(h.props.message, 'restored commit'); assert.equal(refreshes, 1)
  h.invoke(h.find(node => node.type === 'button' && text(node).startsWith('staged.ts'))); assert.deepEqual(diffs, ['staged.ts'])
  h.click('Bỏ stage'); await h.flush(); h.click('Stage tất cả (1 tệp)'); await h.flush()
  assert.ok(calls.some(call => call[0] === 'stage' && call[1] === 'project' && call[2] === 'staged.ts' && call[3] === false && call[4] === undefined))
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(['stageAll', 'project'])))
  h.render({ message: '', git: { branch: 'main', changes: [] } })
  h.change('Sửa commit gần nhất (Amend)', true); await h.flush()
  assert.equal(h.props.message, 'feat: first\n\nFull body')
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(['log', 'project', 1])))
  h.change('Bỏ qua Git hooks (--no-verify)', true); h.render()
  let prevented = 0
  h.invoke(h.byID('git-workspace-commit-input'), 'onKeyDown', { key: 'Enter', ctrlKey: true, metaKey: false, nativeEvent: { isComposing: true }, preventDefault() { prevented++ } })
  assert.equal(calls.filter(call => call[0] === 'commit').length, 0)
  h.invoke(h.byID('git-workspace-commit-input'), 'onKeyDown', { key: 'Enter', ctrlKey: true, metaKey: false, nativeEvent: { isComposing: false }, preventDefault() { prevented++ } })
  await h.flush(); assert.equal(prevented, 1)
  assert.deepEqual(plain(calls.at(-1)), ['commit', 'project', 'feat: first\n\nFull body', { amend: true, noVerify: true }])
  assert.match(h.render(), /Cây làm việc sạch/)
  h.unmount()
})

test('staged rename forwards its original path to diff and unstage', async () => {
  const diffs: unknown[][] = [], stages: unknown[][] = []
  const h = harness({ git: { branch: 'main', changes: [{ path: 'new.txt', from: 'old.txt', index: 'R', working: ' ' }] }, onDiff(...args) { diffs.push(args) } }, { async stage(...args: unknown[]) { stages.push(args) } })
  try {
    h.render(); await h.flush()
    h.invoke(h.find(node => node.type === 'button' && text(node).startsWith('new.txt')))
    assert.deepEqual(plain(diffs), [['new.txt', { kind: 'staged', from: 'old.txt' }]])
    h.click('Bỏ stage'); await h.flush()
    assert.deepEqual(plain(stages), [['project', 'new.txt', false, 'old.txt']])
  } finally { h.unmount() }
})

test('Inspector stages only the destination of a staged rename with working edits, but unstages both paths', async () => {
  const stages: unknown[][] = []
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const source = readFileSync(new URL('../components/Inspector.tsx', import.meta.url), 'utf8')
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText
  const hooks = {
    useState: (initial: unknown) => [initial, () => {}],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect() {},
  }
  const modules: Record<string, unknown> = { react: hooks, './Icon': { Icon }, './Primitives': primitives, './ProjectSearch': { ProjectSearch } }
  runInNewContext(code, {
    exports,
    window: { ame: { async stage(...args: unknown[]) { stages.push(args) } } },
    require: (name: string) => modules[name] ?? nativeRequire(name),
  })
  const Component = exports.Inspector as typeof Inspector
  let tree: ReactNode = Component({
    projectID: 'project', tab: 'git', generation: 0,
    git: { branch: 'main', changes: [{ path: 'new.txt', from: 'old.txt', index: 'R', working: 'M' }] }, gitError: '',
    setTab() {}, refresh() {}, onOpen() {}, onRename() {}, onDelete() {}, onDiff() {}, onHide() {},
    report(error) { assert.fail(String(error)) },
  })
  while (isValidElement(tree) && typeof tree.type === 'function') tree = (tree.type as (props: unknown) => ReactNode)(tree.props)
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    return [node, ...all(node.props.children as ReactNode)]
  }
  const nodes = all(tree)
  for (const group of ['working', 'staged']) {
    assert.ok(nodes.some(node => node.props['data-git-group'] === group && node.props['data-git-path'] === 'new.txt'))
    const control = nodes.find(node => node.props.label === `${group === 'staged' ? 'Bỏ stage' : 'Stage'} new.txt`)
    assert.ok(control, `expected ${group} stage control`)
    assert.notEqual(control.props.disabled, true)
    ;(control.props.onClick as () => void)()
    await tick()
  }
  assert.deepEqual(stages, [['project', 'new.txt', true, undefined], ['project', 'new.txt', false, 'old.txt']])
})

test('merge commit detail explains first-parent comparison and lists merged files', async () => {
  for (const isMerge of [true, false]) {
    const h = harness({ activeTab: 'history' }, {
      async gitLog() { return [first] },
      async gitCommitDetail() { return { ...first, isMerge, files: [{ path: 'merged.ts', status: 'M', additions: 4, deletions: 2 }], patch: 'merge patch' } },
    })
    try {
      h.render(); await h.flush(); h.invoke(h.find(node => node.type === 'button' && text(node).startsWith(first.shortHash)))
      const html = await h.flush()
      assert.match(html, /merged.ts/); assert.match(html, /\+4 −2/)
      if (isMerge) assert.match(html, /Merge commit · so sánh theo parent thứ nhất \(first-parent\)/)
      else assert.doesNotMatch(html, /first-parent/)
    } finally { h.unmount() }
  }
})

test('history loads log and selected detail, filters locally, and keeps HEAD undo tied to the actual first commit', async () => {
  const calls: unknown[][] = []
  const h = harness({ activeTab: 'history' }, {
    async gitLog(...args: unknown[]) { calls.push(['log', ...args]); return [first, second] },
    async gitCommitDetail(...args: unknown[]) { calls.push(['detail', ...args]); return { ...first, files: [{ path: 'first.ts', status: 'M', additions: 3, deletions: 1 }], patch: 'sample patch' } },
  })
  h.render(); let html = await h.flush()
  assert.deepEqual(plain(calls), [['log', 'project', 50]])
  assert.match(html, /abcdef1/); assert.match(html, /Alice/); assert.match(html, /HEAD -&gt; main/)
  h.invoke(h.find(node => node.type === 'button' && text(node).startsWith('abcdef1')))
  html = await h.flush()
  assert.deepEqual(plain(calls.at(-1)), ['detail', 'project', first.hash])
  assert.match(html, /Full body/); assert.match(html, /first.ts/); assert.match(html, /\+3 −1/); assert.match(html, /class="git-commit-patch">sample patch/)
  h.change('Tìm commit', 'bOB'); html = h.render()
  assert.match(html, /fix: second/); assert.doesNotMatch(html, /Hoàn tác \(Soft Reset\)/)
  h.change('Tìm commit', 'abcdef'); html = h.render(); assert.doesNotMatch(html, /fix: second/)
  assert.equal(calls.filter(call => call[0] === 'log').length, 1)
  h.change('Tìm commit', 'missing'); assert.match(h.render(), /Không có commit phù hợp/)
  h.click('Làm mới'); await h.flush(); assert.equal(calls.filter(call => call[0] === 'log').length, 2)
  h.unmount()
})

test('stash push, list, apply, pop and drop reload the list and refresh worktree', async () => {
  const calls: unknown[][] = []
  let list: GitStashEntry[] = [], refreshes = 0
  const h = harness({ activeTab: 'stash', refresh() { refreshes++ } }, {
    async gitStashList() { calls.push(['list']); return list },
    async gitStashPush(...args: unknown[]) { calls.push(['push', ...args]); list = [stash] },
    async gitStashApply(...args: unknown[]) { calls.push(['apply', ...args]); if (args[2]) list = [] },
    async gitStashDrop(...args: unknown[]) { calls.push(['drop', ...args]); list = [] },
  })
  h.render(); assert.match(await h.flush(), /Chưa có stash/)
  h.change('Thông điệp stash', 'my work'); h.render()
  h.invoke(h.find(node => node.type === 'form'), 'onSubmit', { preventDefault() {} })
  let html = await h.flush()
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(['push', 'project', 'my work', true])))
  assert.match(html, /stash@\{0\}/); assert.match(html, /saved work/); assert.match(html, /Stash \(1\)/)
  h.click('Apply'); await h.flush(); assert.deepEqual(plain(calls.find(call => call[0] === 'apply')), ['apply', 'project', 0, false, stash.oid])
  h.click('Pop'); html = await h.flush(); assert.match(html, /Chưa có stash/)
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(['apply', 'project', 0, true, stash.oid])))
  h.change('Gồm tệp mới (untracked)', false); h.render()
  h.invoke(h.find(node => node.type === 'form'), 'onSubmit', { preventDefault() {} }); await h.flush()
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(['push', 'project', '', false])))
  h.click('Xóa'); html = await h.flush()
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(['drop', 'project', 0, stash.oid])))
  assert.match(html, /Chưa có stash/); assert.equal(refreshes, 5)
  h.unmount()
})

test('quick sync publishes untracked branches and formats remote errors', async () => {
  const calls: unknown[][] = []
  const h = harness({ git: { ...base.git!, tracking: null } }, {
    async gitFetch(...args: unknown[]) { calls.push(['fetch', ...args]); return { summary: 'Fetched' } },
    async gitPull(...args: unknown[]) { calls.push(['pull', ...args]); throw new Error('GIT_CONFLICT') },
    async gitPush(...args: unknown[]) { calls.push(['push', ...args]); return { summary: 'Published' } },
  })
  h.render(); await h.flush(); h.click('Fetch'); await h.flush()
  h.click('Publish'); await h.flush()
  assert.deepEqual(plain(calls), [['fetch', 'project'], ['push', 'project', { setUpstream: true }]])
  h.click('Pull ↓1'); assert.match(await h.flush(), /Phát sinh xung đột/)
  h.unmount()
})

test('stale project mutations and unmount completions cannot overwrite newer state or push', async () => {
  for (const boundary of ['project', 'unmount']) {
    const request = deferred<void>()
    let pushes = 0, refreshes = 0, messages = 0
    const h = harness({ onMessageChange() { messages++ }, refresh() { refreshes++ } }, {
      commit() { return request.promise }, async gitPush() { pushes++; return { summary: '' } },
    })
    h.render(); await h.flush(); h.invoke(h.byID('git-workspace-commit-push-btn'))
    if (boundary === 'unmount') h.unmount()
    else { h.render({ projectID: 'other', message: 'new draft' }); await h.flush() }
    const writes = h.writes
    request.resolve(); await tick()
    assert.equal(h.writes, writes); assert.equal(pushes, 0); assert.equal(refreshes, 0); assert.equal(messages, 0)
    if (boundary !== 'unmount') h.unmount()
  }
})

test('watcher refreshes retain an in-flight Git lock and finish Commit & Push', async () => {
  const request = deferred<void>()
  let commits = 0, pushes = 0
  const h = harness({}, {
    commit() { commits++; return request.promise },
    async gitPush() { pushes++; return { summary: 'pushed' } },
  })
  try {
    h.render(); await h.flush(); h.invoke(h.byID('git-workspace-commit-push-btn'))
    h.render({ generation: 1 }); await h.flush()
    assert.equal(h.byID('git-workspace-commit-push-btn').props.disabled, true)
    assert.equal(commits, 1)
    request.resolve(); await h.flush()
    assert.equal(pushes, 1)
    assert.equal(h.props.message, '')
    assert.equal(h.byID('git-workspace-commit-btn').props.disabled, true, 'empty message stays disabled')
  } finally { request.resolve(); h.unmount() }
})

test('CANCELLED remains silent, while asynchronous list/detail responses respect selection and project boundaries', async () => {
  const a = deferred<unknown>(), b = deferred<unknown>()
  const h = harness({ activeTab: 'history' }, {
    async gitLog() { return [first, second] },
    gitCommitDetail(_id: string, hash: string) { return hash === first.hash ? a.promise : b.promise },
    async generateCommitMessage() { throw new Error('CANCELLED') },
  })
  h.render(); await h.flush()
  h.invoke(h.find(node => node.type === 'button' && text(node).startsWith(first.shortHash))); h.render()
  h.invoke(h.find(node => node.type === 'button' && text(node).startsWith(second.shortHash))); h.render()
  b.resolve({ ...second, files: [], patch: 'current patch' }); await h.flush()
  a.resolve({ ...first, files: [], patch: 'stale patch' })
  let html = await h.flush(); assert.match(html, /current patch/); assert.doesNotMatch(html, /stale patch/)
  h.render({ activeTab: 'commit' }); h.invoke(h.byID('git-workspace-enhance-btn'))
  html = await h.flush(); assert.doesNotMatch(html, /role="alert"/); assert.equal(h.byID('git-workspace-enhance-btn').props.disabled, false)
  h.unmount()

  const oldLog = deferred<GitCommitSummary[]>(), oldStash = deferred<GitStashEntry[]>()
  const stale = harness({ activeTab: 'history' }, {
    gitLog(id: string) { return id === 'project' ? oldLog.promise : Promise.resolve([second]) },
    gitStashList(id: string) { return id === 'project' ? oldStash.promise : Promise.resolve([]) },
  })
  stale.render(); stale.render({ projectID: 'other' }); await stale.flush()
  const writes = stale.writes
  oldLog.resolve([first]); oldStash.resolve([stash]); await tick()
  assert.equal(stale.writes, writes)
  html = stale.render(); assert.doesNotMatch(html, /feat: first/); assert.match(html, /fix: second/); assert.match(html, /Stash \(0\)/)
  stale.unmount()
})
