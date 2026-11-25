import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { ChatItem, CommitAgentExecuteFailure, CommitAgentInfo, IdeEvent, Permission, Session, SessionForm } from '../../../../../packages/protocol/src/index'
import * as timeline from '../chat-timeline'
import { extractCommitSnapshotID, inspectCommitAgentPlan, parseCommitAgentPlan } from '../../../../../packages/amekit/src/commit-plan'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function harness(resume = false, overrides: Partial<CommitAgentInfo> = {}) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, writes = 0, tree: ReactNode
  let closed = 0, refreshed = 0
  let info: CommitAgentInfo = { configured: false, effectiveModelID: 'default', fallbackToDefault: false, stagedCount: 2, workingCount: 3, branch: 'main', commitSessionIDs: resume ? ['commit-1'] : [], lockedSessionIDs: [], ...overrides }
  let sessions: Session[] = resume ? [{ id: 'commit-1', title: 'Commit', status: 'idle' }] : []
  let items: ChatItem[] = [], forms: SessionForm[] = [], permissions: Permission[] = []
  let formsError = '', lockError = '', sessionsError = '', permissionsError = '', executeError = '', infoLoads = 0
  let promptPlan: { planID: string; snapshot: NonNullable<CommitAgentInfo['snapshot']> } | undefined
  let partialFailure: CommitAgentExecuteFailure | undefined
  const calls: { method: string; args: unknown[] }[] = [], applied: string[] = []
  const events = new Set<(event: IdeEvent) => void>(), listeners = new Map<string, Set<() => void>>()
  const hooks = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: unknown) => { const value = typeof next === 'function' ? next(slots[i]) : next; if (!Object.is(slots[i], value)) { slots[i] = value; writes++ } }] },
    useRef(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) { const i = effectIndex++, old = effects[i]; if (!old || deps.some((dep, j) => !Object.is(dep, old.deps[j]))) pending.push(() => { old?.cleanup?.(); effects[i] = { deps, cleanup: run() } }) },
  }
  const api = {
    async commitAgentInfo() { infoLoads++; return info },
    async commitAgentExecutePlan(...args: unknown[]) { calls.push({ method: 'execute', args }); if (executeError) throw new Error(executeError); return { commits: [{ hash: 'created-hash-1' }, { hash: 'created-hash-2' }], partialFailure } },
    async commitAgentPrompt(...args: unknown[]) {
      calls.push({ method: 'prompt', args })
      sessions = [{ id: 'commit-1', title: 'Commit', status: 'running' }]
      info = { ...info, commitSessionIDs: ['commit-1'] }
      items = [...items, { id: `user-${items.length}`, role: 'user', text: `${promptPlan ? `[Commit snapshot: ${promptPlan.planID}]\n` : ''}${String(args[2])}` }]
      return { session: sessions[0], model: { id: 'default', name: 'Default', providerID: 'amecode' }, locked: false, ...promptPlan }
    },
    async commitAgentLock(...args: unknown[]) { calls.push({ method: 'lock', args }); if (lockError) throw new Error(lockError); info = { ...info, lockedSessionIDs: [String(args[1])] }; return info },
    async messages() { return items }, async sessions() { if (sessionsError) throw new Error(sessionsError); return sessions }, async permissions() { if (permissionsError) throw new Error(permissionsError); return permissions },
    async forms(_projectID: string, sessionID: string) { if (formsError) throw new Error(formsError); return forms.filter(form => form.sessionID === sessionID) },
    async models() { return [] }, async agentMap() { return { nodes: [] } },
    async replyPermission(...args: unknown[]) { calls.push({ method: 'permission', args }); permissions = [] },
    async cancel(...args: unknown[]) { calls.push({ method: 'cancel', args }); sessions = sessions.map(session => ({ ...session, status: 'idle' })); forms = [] },
    onEvent(fn: (event: IdeEvent) => void) { events.add(fn); return () => events.delete(fn) },
  }
  const marker = () => null
  const modules: Record<string, unknown> = {
    react: hooks, '../chat-timeline': timeline,
    '../../../../../packages/amekit/src/commit-plan': { extractCommitSnapshotID, inspectCommitAgentPlan, parseCommitAgentPlan },
    './Icon': { Icon: marker }, './MessageContent': { MessageContent: ({ text }: { text: string }) => text },
    './Primitives': { errorText: (e: unknown) => String(e).replace(/^Error: /, ''), IconButton: marker },
    './SessionChanges': { TurnChanges: marker }, './ToolCard': { ToolCard: marker },
    './SessionFormCard': { SessionFormCard: ({ form }: { form: SessionForm }) => `Pending form: ${form.title}` },
    './TurnWorkGroup': { TurnWorkGroup: marker, ActiveToolsView: ({ items }: { items: ChatItem[] }) => `Active tools: ${items.map(item => item.tool?.name).join(', ')}`, LiveTurnStatus: ({ label }: { label: string }) => label },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const code = ts.transpileModule(readFileSync(new URL('../components/CommitAgentModal.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, Event, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, document: { activeElement: null }, window: {
    ame: api, addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn) }, dispatchEvent(event: Event) { listeners.get(event.type)?.forEach(fn => fn()) },
  }, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Component = exports.CommitAgentModal as (props: object) => ReactNode
  const props = { projectID: 'project', projectName: 'App', connected: true, theme: 'dark', onClose() { closed++ }, onActivity() {}, onGitRefresh() { refreshed++ }, onApplyCommitMessage(message: string) { applied.push(message) }, onOpenFile() {} }
  function render(extra: object = {}) { Object.assign(props, extra); for (let pass = 0; pass < 10; pass++) { const before = writes; cursor = 0; effectIndex = 0; tree = Component(props); pending.splice(0).forEach(run => run()); if (before === writes) return renderToStaticMarkup(tree) } throw new Error('Effects did not settle') }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] { if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement<Record<string, unknown>>(node)) return []; return [node, ...all(node.props.children as ReactNode)] }
  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) { const node = all(tree).find(predicate); assert.ok(node, 'Expected element'); return node }
  function button(text: string) { return find(node => node.type === 'button' && renderToStaticMarkup(node.props.children as ReactNode).includes(text)) }
  return {
    render, find, button, calls, applied,
    approvals: () => all(tree).filter(node => node.props['data-testid'] === 'commit-plan-approval'),
    executeButtons: () => all(tree).filter(node => node.props['data-testid'] === 'commit-plan-execute-btn'),
    setInfo(value: Partial<CommitAgentInfo>) { info = { ...info, ...value }; listeners.get('ame-commit-agent-changed')?.forEach(fn => fn()) },
    setPromptPlan(value: typeof promptPlan) { promptPlan = value },
    setPartialFailure(value: CommitAgentExecuteFailure) { partialFailure = value },
    click(text: string) { const node = button(text); assert.ok(!node.props.disabled, `${text} enabled`); (node.props.onClick as () => void)() },
    async flush() { for (let i = 0; i < 4; i++) { await tick(); render() } return render() },
    update(value: { session?: Partial<Session>; sessions?: Session[]; items?: ChatItem[]; forms?: SessionForm[]; permissions?: Permission[]; formsError?: string; sessionsError?: string; permissionsError?: string; executeError?: string; lockError?: string }) { if (value.session) sessions = [{ id: 'commit-1', title: 'Commit', ...value.session }]; if (value.sessions) sessions = value.sessions; if (value.items) items = value.items; if (value.forms) forms = value.forms; if (value.permissions) permissions = value.permissions; if (value.formsError !== undefined) formsError = value.formsError; if (value.sessionsError !== undefined) sessionsError = value.sessionsError; if (value.permissionsError !== undefined) permissionsError = value.permissionsError; if (value.executeError !== undefined) executeError = value.executeError; if (value.lockError !== undefined) lockError = value.lockError },
    emit() { events.forEach(fn => fn({ type: 'opencode', projectID: 'project', sessionID: 'commit-1' })) },
    get closed() { return closed }, get refreshed() { return refreshed },
    get infoLoads() { return infoLoads },
    unmount() { effects.forEach(effect => effect.cleanup?.()); assert.equal(events.size, 0) },
  }
}

test('initialSessionID opens A with its pending form instead of newer unlocked B', async () => {
  for (const initialSessionID of ['A', undefined]) {
    const h = harness(false, { commitSessionIDs: ['A', 'B'] })
    try {
      h.update({ sessions: ['A', 'B'].map(id => ({ id, title: id, status: 'idle' })), forms: ['A', 'B'].map(id => ({ id: `form-${id}`, sessionID: id, title: `Question ${id}`, fields: [{ key: 'answer', type: 'string' }] })) })
      h.render({ initialSessionID }); const html = await h.flush()
      assert.match(html, new RegExp(`Pending form: Question ${initialSessionID ?? 'B'}`))
      assert.doesNotMatch(html, new RegExp(`Pending form: Question ${initialSessionID ? 'B' : 'A'}`))
      assert.equal((h.find(node => !!node.props.form).props.form as SessionForm).sessionID, initialSessionID ?? 'B')
    } finally { h.unmount() }
  }
})

test('finish fails closed when sessions, permissions or forms rejects, including after a successful load', async () => {
  for (const key of ['sessionsError', 'permissionsError', 'formsError'] as const) {
    for (const previouslyReady of [false, true]) {
      const h = harness(true)
      try {
        if (previouslyReady) { h.render(); await h.flush(); assert.equal(h.button('✓ Hoàn tất').props.disabled, false) }
        h.update({ [key]: 'UNAVAILABLE' }); h.render(); h.emit()
        assert.match(await h.flush(), /UNAVAILABLE/)
        const finish = h.button('✓ Hoàn tất'); assert.equal(finish.props.disabled, true)
        ;(finish.props.onClick as () => void)(); await h.flush()
        assert.equal(h.calls.some(call => call.method === 'lock'), false)
        h.update({ [key]: '' }); h.emit(); await h.flush()
        assert.equal(h.button('✓ Hoàn tất').props.disabled, false)
      } finally { h.unmount() }
    }
  }
})

test('finish requires a known idle session and stays disabled while prompting or running', async () => {
  for (const status of [undefined, 'running'] as const) {
    const h = harness(true)
    try { h.update({ session: { status } }); h.render(); await h.flush(); assert.equal(h.button('✓ Hoàn tất').props.disabled, true) } finally { h.unmount() }
  }
  const h = harness(true)
  try {
    h.render(); await h.flush(); h.click('Viết 1 thông điệp'); h.render()
    assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
    await h.flush(); assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
    assert.equal(h.button('Dừng phản hồi').props.disabled, false)
  } finally { h.unmount() }
})

const snapshot = { head: 'head-before', branchRef: 'refs/heads/feature', indexHash: 'index-before', workingHash: 'working-before', untrackedHashes: { 'new.ts': 'new-hash' }, scope: 'staged' as const, fingerprint: 'fingerprint', stagedFiles: ['one.ts', 'two.ts'], workingFiles: [] }
const planCommits = [{ message: 'feat: first\n\nChi tiết', files: ['one.ts'] }, { message: 'fix: second', files: ['two.ts'] }]
test('structured plans show scope, HEAD and every commit, execute exact snapshot, refresh info and show hashes', async () => {
  for (const scope of [undefined, 'working'] as const) {
    const h = harness(true, { snapshot, plans: { happy: { planID: 'happy', snapshot, status: 'active' } } })
    try {
      h.update({ items: planTurn('happy').map(item => item.role === 'assistant' ? { ...item, text: `\`\`\`commit-plan\n${JSON.stringify({ scope, commits: planCommits })}\n\`\`\`` } : item) })
      h.render(); const html = await h.flush()
      assert.match(html, /data-testid="commit-plan-approval"/); assert.match(html, /Kế hoạch Commit chờ duyệt/)
      assert.match(html, new RegExp(`Phạm vi: ${scope ?? 'staged'}`)); assert.match(html, /head-before/); assert.match(html, /Nhánh: refs\/heads\/feature/)
      assert.match(html, /1\. feat: first/); assert.match(html, /2\. fix: second/); assert.match(html, /one.ts/); assert.match(html, /two.ts/)
      const loads = h.infoLoads
      h.click('Duyệt &amp; thực thi 2 commit')
      const result = await h.flush()
      assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { method: 'execute', args: ['project', 'commit-1', { planID: 'happy', scope: scope ?? 'staged', snapshot: { head: snapshot.head, branchRef: snapshot.branchRef, indexHash: snapshot.indexHash, workingHash: snapshot.workingHash, untrackedHashes: snapshot.untrackedHashes }, commits: planCommits }] })
      assert.match(result, /created-hash-1, created-hash-2/); assert.equal(h.refreshed, 1); assert.ok(h.infoLoads > loads)
      assert.equal(h.button('Duyệt &amp; thực thi').props.disabled, true); assert.match(result, /Kế hoạch này đã thực thi/)
    } finally { h.unmount() }
  }
})

test('ID-bound stale plan stays disabled after info refresh without rebinding its snapshot', async () => {
  const h = harness(true, { snapshot, plans: { saved: { planID: 'saved', snapshot, status: 'active' } } })
  try {
    h.update({ executeError: 'COMMIT_PLAN_STALE', items: planTurn('saved') })
    h.render(); await h.flush(); const loads = h.infoLoads; h.click('Duyệt &amp; thực thi')
    const html = await h.flush()
    assert.match(html, /Trạng thái Git đã thay đổi/); assert.match(html, /Lập lại kế hoạch/)
    assert.doesNotMatch(html, /Đã tạo commit:/); assert.equal(h.refreshed, 0); assert.equal(h.infoLoads, loads)
    h.setInfo({ snapshot: { ...snapshot, head: 'new-head' } }); await h.flush()
    assert.equal(h.button('Duyệt &amp; thực thi').props.disabled, true)
    assert.match(await h.flush(), /head-before/)
    ;(h.button('Duyệt &amp; thực thi').props.onClick as () => void)(); await h.flush()
    assert.equal(h.calls.filter(call => call.method === 'execute').length, 1)
  } finally { h.unmount() }
})

const planText = `\`\`\`commit-plan\n${JSON.stringify({ commits: planCommits })}\n\`\`\``
const planTurn = (id: string): ChatItem[] => [{ id: `user-${id}`, role: 'user', text: `[Commit snapshot: ${id}]\nAnalyze` }, { id: `answer-${id}`, role: 'assistant', text: planText }]

test('structured partial failure preserves created hashes, stopped group and detail, refreshes Git and makes the plan stale', async () => {
  const h = harness(true, { plans: { saved: { planID: 'saved', snapshot, status: 'active' } } })
  try {
    h.setPartialFailure({ code: 'COMMIT_FAILED', message: 'Hook rejected the next commit', failedGroupIndex: 2, failedSubject: 'fix: stopped group' })
    h.update({ items: planTurn('saved') }); h.render(); await h.flush()
    const loads = h.infoLoads
    h.click('Duyệt &amp; thực thi'); const html = await h.flush()
    assert.match(html, /role="status">Đã tạo commit: created-hash-1, created-hash-2/)
    const alert = renderToStaticMarkup(h.find(node => node.props.role === 'alert'))
    assert.match(alert, /created-hash-1, created-hash-2/)
    assert.match(alert, /nhóm #3: fix: stopped group/)
    assert.match(alert, /Hook rejected the next commit/)
    assert.equal(h.refreshed, 1); assert.ok(h.infoLoads > loads)
    assert.match(html, /Kế hoạch đã cũ/); assert.doesNotMatch(html, /Kế hoạch này đã thực thi/)
    assert.equal(h.executeButtons()[0].props.disabled, true)
    h.setInfo({ plans: { saved: { planID: 'saved', snapshot, status: 'active' } } }); await h.flush()
    ;(h.executeButtons()[0].props.onClick as () => void)(); await h.flush()
    assert.equal(h.calls.filter(call => call.method === 'execute').length, 1)
  } finally { h.unmount() }
})

test('executing plans block both button and handler, then recover to active from backend info', async () => {
  const h = harness(true, { plans: { saved: { planID: 'saved', snapshot, status: 'executing' } } })
  try {
    h.update({ items: planTurn('saved') }); h.render()
    assert.match(await h.flush(), /Kế hoạch đang được thực thi…/)
    assert.equal(h.executeButtons()[0].props.disabled, true)
    ;(h.executeButtons()[0].props.onClick as () => void)(); await h.flush()
    assert.equal(h.calls.length, 0)
    h.setInfo({ plans: { saved: { planID: 'saved', snapshot: { ...snapshot, head: 'new-head' }, status: 'active' } } })
    const html = await h.flush()
    assert.doesNotMatch(html, /Kế hoạch đang được thực thi…/)
    assert.match(html, /head-before/); assert.equal(h.executeButtons()[0].props.disabled, false)
    h.click('Duyệt &amp; thực thi'); await h.flush()
    assert.equal(h.calls.filter(call => call.method === 'execute').length, 1)
    assert.equal((h.calls[0].args[2] as { snapshot: { head: string } }).snapshot.head, snapshot.head)
  } finally { h.unmount() }
})

test('201-file plans stay visible with exact group limit diagnostics and cannot invoke execution IPC', async () => {
  const h = harness(true, { plans: { oversized: { planID: 'oversized', snapshot, status: 'active' } } })
  try {
    const commits = [planCommits[0], { message: 'feat: oversized', files: Array.from({ length: 201 }, (_, i) => `file-${i}.ts`) }]
    h.update({ items: [...planTurn('older'), ...planTurn('oversized').map(item => item.role === 'assistant' ? { ...item, text: `\`\`\`commit-plan\n${JSON.stringify({ commits })}\n\`\`\`` } : item)] })
    h.render(); await h.flush()
    assert.equal(h.approvals().length, 2)
    const card = renderToStaticMarkup(h.approvals()[1])
    assert.match(card, /Nhóm #2 có 201 tệp, vượt giới hạn 200 tệp\/nhóm/)
    assert.match(card, /hãy yêu cầu chia nhóm trước khi duyệt/)
    assert.match(card, /file-200.ts/); assert.match(card, /Lập lại kế hoạch/)
    assert.equal(h.button('Lập lại kế hoạch').props.disabled, false)
    assert.ok(h.executeButtons().every(button => button.props.disabled))
    for (const button of h.executeButtons()) (button.props.onClick as () => void)()
    await h.flush(); assert.equal(h.calls.length, 0)
  } finally { h.unmount() }
})

test('legacy cards without planID fail closed and offer replanning even with info.snapshot', async () => {
  for (const plans of [undefined, {}]) {
    const h = harness(true, { snapshot, plans })
    try {
      h.update({ items: [{ id: 'legacy', role: 'assistant', text: planText }] })
      h.render(); const html = await h.flush()
      assert.equal(h.executeButtons().length, 1)
      assert.equal(h.executeButtons()[0].props.disabled, true)
      assert.match(html, /Snapshot không còn trong phiên — hãy lập lại kế hoạch/)
      assert.equal(h.button('Lập lại kế hoạch').props.disabled, false)
      ;(h.executeButtons()[0].props.onClick as () => void)(); await h.flush()
      assert.equal(h.calls.filter(call => call.method === 'execute').length, 0)
    } finally { h.unmount() }
  }
})

test('whitespace filenames are visibly quoted, preserve whitespace and execute exact paths', async () => {
  const files = [' a.txt', 'a.txt', 'a.txt ']
  const commits = [{ message: 'fix: whitespace paths', files }]
  const h = harness(true, { plans: { spaces: { planID: 'spaces', snapshot, status: 'active' } } })
  try {
    h.update({ items: planTurn('spaces').map(item => item.role === 'assistant' ? { ...item, text: `\`\`\`commit-plan\n${JSON.stringify({ commits })}\n\`\`\`` } : item) })
    h.render(); await h.flush()
    const html = renderToStaticMarkup(h.approvals()[0])
    assert.match(html, /<li style="white-space:pre"><code>&quot; a.txt&quot;<\/code><\/li>/)
    assert.match(html, /<li style="white-space:pre">a.txt<\/li>/)
    assert.match(html, /<li style="white-space:pre"><code>&quot;a.txt &quot;<\/code><\/li>/)
    h.click('Duyệt &amp; thực thi'); await h.flush()
    const payload = JSON.parse(JSON.stringify(h.calls[0].args[2]))
    assert.equal(payload.planID, 'spaces')
    assert.deepEqual(payload.commits, commits)
  } finally { h.unmount() }
})

test('messagePlanIDs resolves quoted User request markers and takes precedence over parsed headers', async () => {
  for (const text of ['Analyze\n\nUser request:\nquoted', '[Commit snapshot: other]\nAnalyze\n\nUser request:\nquoted', '[Commit snapshot: other]\nAnalyze']) {
    const h = harness(true, { messagePlanIDs: { 'user-saved': 'saved' }, plans: { saved: { planID: 'saved', snapshot, status: 'active' } } })
    try {
      h.update({ items: planTurn('saved').map(item => item.role === 'user' ? { ...item, text } : item) })
      h.render(); await h.flush()
      assert.equal(h.executeButtons()[0].props.disabled, false)
      h.click('Duyệt &amp; thực thi'); await h.flush()
      assert.equal((h.calls[0].args[2] as { planID: string }).planID, 'saved')
    } finally { h.unmount() }
  }
})

test('snapshot header preceding request prose resolves planID without messagePlanIDs', async () => {
  for (const text of ['[Commit snapshot: saved]\nAnalyze', 'Context\n\nUser request:\n[Commit snapshot: saved]\nAnalyze\n\nUser request:\nquoted']) {
    assert.equal(extractCommitSnapshotID(text), 'saved')
    const h = harness(true, { plans: { saved: { planID: 'saved', snapshot, status: 'active' } } })
    try {
      h.update({ items: planTurn('saved').map(item => item.role === 'user' ? { ...item, text } : item) })
      h.render(); await h.flush(); h.click('Duyệt &amp; thực thi'); await h.flush()
      assert.equal((h.calls[0].args[2] as { planID: string }).planID, 'saved')
    } finally { h.unmount() }
  }
})

test('aborted and hook-modified plans become stale and mismatches show a Vietnamese error', async () => {
  for (const [executeError, expected, stale] of [
    ['COMMIT_PLAN_ABORTED', /Thực thi kế hoạch đã bị hủy/, true],
    ['COMMIT_PLAN_HOOK_MODIFIED_TREE', /Git hook đã thay đổi cây làm việc/, true],
    ['COMMIT_PLAN_MISMATCH', /Kế hoạch không khớp với dữ liệu đã lưu/, false],
  ] as const) {
    const h = harness(true, { plans: { saved: { planID: 'saved', snapshot, status: 'active' } } })
    try {
      h.update({ items: planTurn('saved'), executeError }); h.render(); await h.flush()
      h.click('Duyệt &amp; thực thi'); const html = await h.flush()
      assert.match(html, expected)
      assert.equal(h.executeButtons()[0].props.disabled, stale)
      if (stale) {
        assert.match(html, /Lập lại kế hoạch/)
        h.setInfo({ plans: { saved: { planID: 'saved', snapshot, status: 'active' } } }); await h.flush()
        assert.equal(h.executeButtons()[0].props.disabled, true)
        ;(h.executeButtons()[0].props.onClick as () => void)(); await h.flush()
        assert.equal(h.calls.filter(call => call.method === 'execute').length, 1)
      }
    } finally { h.unmount() }
  }
})

test('stale ID-bound plans require a new prompt and new planID; only the latest plan can execute once', async () => {
  const first = { ...snapshot, branch: 'feature-first' }
  const second = { ...snapshot, head: 'head-second', branchRef: 'refs/heads/second' }
  const h = harness(true, { snapshot: second, plans: { first: { planID: 'first', snapshot: first, status: 'active' } } })
  try {
    h.update({ items: planTurn('first'), executeError: 'COMMIT_PLAN_STALE' })
    h.render(); assert.match(await h.flush(), /Nhánh: feature-first/)
    h.click('Duyệt &amp; thực thi'); await h.flush()
    assert.equal(h.executeButtons()[0].props.disabled, true)
    assert.match(h.render(), /Kế hoạch đã cũ/)
    h.setInfo({ plans: { first: { planID: 'first', snapshot: second, status: 'active' } } }); await h.flush()
    assert.equal(h.executeButtons()[0].props.disabled, true)
    assert.match(h.render(), /HEAD: <code>head-before/)
    h.setPromptPlan({ planID: 'second', snapshot: second })
    h.click('Lập lại kế hoạch'); await h.flush()
    assert.deepEqual(h.calls.at(-1)?.args.slice(0, 3), ['project', 'commit-1', 'Lập lại kế hoạch'])
    h.update({ session: { status: 'idle' }, executeError: '', items: [...planTurn('first'), ...planTurn('second')] }); h.emit(); await h.flush()
    assert.deepEqual(h.executeButtons().map(node => node.props.disabled), [true, false])
    assert.match(h.render(), /Kế hoạch đã được thay thế/)
    ;(h.executeButtons()[0].props.onClick as () => void)(); await h.flush()
    assert.equal(h.calls.filter(call => call.method === 'execute').length, 1)
    ;(h.executeButtons()[1].props.onClick as () => void)(); await h.flush()
    const executions = h.calls.filter(call => call.method === 'execute')
    assert.deepEqual(JSON.parse(JSON.stringify(executions[0].args[2])), { planID: 'first', scope: 'staged', snapshot: { head: first.head, branchRef: first.branchRef, indexHash: first.indexHash, workingHash: first.workingHash, untrackedHashes: first.untrackedHashes }, commits: planCommits })
    assert.deepEqual(JSON.parse(JSON.stringify(executions[1].args[2])), { planID: 'second', scope: 'staged', snapshot: { head: second.head, branchRef: second.branchRef, indexHash: second.indexHash, workingHash: second.workingHash, untrackedHashes: second.untrackedHashes }, commits: planCommits })
    assert.deepEqual(h.executeButtons().map(node => node.props.disabled), [true, true])
    assert.match(h.render(), /Kế hoạch này đã thực thi/)
  } finally { h.unmount() }
})

test('restored stale, executed, superseded and missing ID snapshots fail closed even with current info.snapshot', async () => {
  for (const status of ['stale', 'executed', 'superseded', 'missing'] as const) {
    const h = harness(true, { snapshot, plans: status === 'missing' ? {} : { saved: { planID: 'saved', snapshot, status } } })
    try {
      h.update({ items: planTurn('saved') }); h.render(); const html = await h.flush()
      assert.equal(h.executeButtons()[0].props.disabled, true)
      assert.match(html, status === 'missing' ? /Snapshot không còn trong phiên/ : status === 'stale' ? /Kế hoạch đã cũ/ : status === 'executed' ? /Kế hoạch này đã thực thi/ : /Kế hoạch đã được thay thế/)
      ;(h.executeButtons()[0].props.onClick as () => void)(); await h.flush()
      assert.equal(h.calls.length, 0)
    } finally { h.unmount() }
  }
})

test('historical turns without IDs cannot borrow current snapshot when stored plans exist', async () => {
  const h = harness(true, { snapshot, plans: {} })
  try {
    h.update({ items: [{ id: 'legacy', role: 'assistant', text: planText }, ...planTurn('missing')] })
    h.render(); await h.flush()
    assert.deepEqual(h.executeButtons().map(node => node.props.disabled), [true, true])
    assert.doesNotMatch(h.approvals().map(card => renderToStaticMarkup(card)).join(''), /head-before/)
  } finally { h.unmount() }
})

test('legacy cards never bind an older turn or ambiguous multi-plan history', async () => {
  for (const items of [
    [{ id: 'old', role: 'assistant', text: planText }, { id: 'new-request', role: 'user', text: 'Another request' }],
    [{ id: 'old', role: 'assistant', text: planText }, { id: 'new-request', role: 'user', text: 'Another request' }, { id: 'new', role: 'assistant', text: planText }],
  ] satisfies ChatItem[][]) {
    const h = harness(true, { snapshot })
    try {
      h.update({ items }); h.render(); await h.flush()
      assert.ok(h.executeButtons().every(button => button.props.disabled))
      assert.doesNotMatch(h.approvals().map(card => renderToStaticMarkup(card)).join(''), /head-before/)
    } finally { h.unmount() }
  }
})

test('plan approval is hidden for malformed plans and locked or running sessions', async () => {
  for (const mode of ['malformed', 'locked', 'running']) {
    const h = harness(true, { snapshot, lockedSessionIDs: mode === 'locked' ? ['commit-1'] : [] })
    try {
      h.update({ session: { status: mode === 'running' ? 'running' : 'idle' }, items: [{ id: 'plan', role: 'assistant', text: `\`\`\`commit-plan\n${mode === 'malformed' ? '{}' : JSON.stringify({ commits: planCommits })}\n\`\`\`` }] })
      h.render({ initialSessionID: 'commit-1' }); assert.doesNotMatch(await h.flush(), /data-testid="commit-plan-approval"/)
    } finally { h.unmount() }
  }
})

test('all three presets use dedicated commit prompts without requiring a configured skill', async () => {
  for (const [title, mode, pattern] of [['Phân tích &amp; đề xuất', 'analyze', /question/], ['Phân tích &amp; thực thi', 'split', /UTF-8/], ['Viết 1 thông điệp', 'single', /không cắt 64KB/]] as const) {
    const h = harness()
    try { h.render(); const html = await h.flush(); assert.match(html, /Conventional Commits/); assert.match(html, /2 staged · 3 chưa stage/); h.click(title); await h.flush(); assert.equal(h.calls[0].method, 'prompt'); assert.deepEqual(h.calls[0].args.slice(0, 2), ['project', undefined]); assert.equal(h.calls[0].args[3], mode); assert.match(String(h.calls[0].args[2]), pattern) } finally { h.unmount() }
  }
})

test('question forms render, block finishing, and resolve through SessionFormCard', async () => {
  const h = harness(true)
  try {
    h.update({ items: [{ id: 'q', role: 'assistant', kind: 'tool', text: '', tool: { name: 'question', status: 'running' } }], forms: [{ id: 'f', sessionID: 'commit-1', title: 'Tách 8 commit hay gộp?', fields: [{ key: 'choice', type: 'string' }] }] })
    h.render(); const html = await h.flush(); assert.match(html, /Pending form: Tách 8 commit hay gộp/); assert.match(html, /Đang chờ bạn trả lời/); assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
    const form = h.find(node => !!node.props.form)
    assert.equal(form.props.projectID, 'project'); assert.equal(form.props.disabled, false)
    h.update({ forms: [] }); (form.props.onResolved as (id: string) => void)('f'); assert.doesNotMatch(await h.flush(), /Pending form:/)
  } finally { h.unmount() }
})

test('permission cards support once, always and reject replies', async () => {
  for (const [title, response] of [['Cho phép một lần', 'once'], ['Luôn cho phép', 'always'], ['Từ chối', 'reject']]) {
    const h = harness(true)
    try { h.update({ permissions: [{ id: 'permission', sessionID: 'commit-1', title: 'git commit' }] }); h.render(); await h.flush(); h.click(title); await h.flush(); assert.deepEqual(h.calls[0], { method: 'permission', args: ['project', 'permission', response] }); assert.doesNotMatch(h.render(), /Yêu cầu quyền/) } finally { h.unmount() }
  }
})

test('new session stays enabled during running and while awaiting a question', async () => {
  for (const waiting of [false, true]) {
    const h = harness(true)
    try { h.update({ session: { status: waiting ? 'idle' : 'running' }, items: [{ id: 'old', role: 'user', text: 'Old request' }], forms: waiting ? [{ id: 'f', sessionID: 'commit-1', title: 'Chọn cách tách', fields: [{ key: 'choice', type: 'string' }] }] : [] }); h.render(); await h.flush(); assert.equal(h.button('Phiên mới').props.disabled, false); h.click('Phiên mới'); assert.doesNotMatch(h.render(), /Old request|Pending form/); h.click('Viết 1 thông điệp'); await h.flush(); assert.equal(h.calls[0].args[1], undefined); assert.equal(h.refreshed, 0) } finally { h.unmount() }
  }
})

test('commit message buttons apply the exact UTF-8 message and announce success', async () => {
  for (const count of [1, 8]) {
    const h = harness(true), messages = Array.from({ length: count }, (_, i) => `feat(git): thay đổi ${i}\n\nNội dung UTF-8`)
    try { h.update({ items: [{ id: 'answer', role: 'assistant', text: messages.map(message => `\`\`\`commit\n${message}\n\`\`\``).join('\n') }] }); h.render(); await h.flush(); h.click(count === 1 ? 'Điền vào ô Commit' : 'Điền commit #8'); assert.deepEqual(h.applied, [messages[count - 1]]); assert.match(h.render(), /Đã điền vào ô Commit/) } finally { h.unmount() }
  }
})

test('running to idle refreshes Git exactly once; stopping reloads immediately', async () => {
  const h = harness(true)
  try { h.update({ session: { status: 'running' } }); h.render(); await h.flush(); assert.equal(h.refreshed, 0); h.click('Dừng phản hồi'); await h.flush(); assert.deepEqual(h.calls[0], { method: 'cancel', args: ['project', 'commit-1'] }); assert.equal(h.refreshed, 1); assert.doesNotMatch(h.render(), /Dừng phản hồi/); h.emit(); await h.flush(); assert.equal(h.refreshed, 1) } finally { h.unmount() }
})

test('event-driven running to idle refreshes Git even without stopping', async () => {
  const h = harness(true)
  try { h.update({ session: { status: 'running' } }); h.render(); await h.flush(); h.update({ session: { status: 'idle' } }); h.emit(); await h.flush(); assert.equal(h.refreshed, 1) } finally { h.unmount() }
})

test('failed outcome surfaces timeline errors in every detail mode and hides completion banner', async () => {
  for (const timelineDetail of ['compact', 'detailed', 'everything']) {
    const h = harness(true)
    try { h.update({ session: { status: 'idle', outcome: 'failed' }, items: [{ id: 'error', role: 'assistant', kind: 'error', text: 'Compaction token limit exceeded' }] }); h.render({ timelineDetail }); const html = await h.flush(); assert.match(html, /role="alert">Compaction token limit exceeded/); assert.match(html, /Ngữ cảnh phiên vượt giới hạn token/); assert.match(html, /Lượt commit gần nhất gặp lỗi/); assert.doesNotMatch(html, /Đã xong\?/); h.click('Phiên mới'); assert.doesNotMatch(h.render(), /Compaction token limit/) } finally { h.unmount() }
  }
})

test('finish locks the dedicated session, refreshes Git and closes; failures keep it open', async () => {
  const h = harness(true)
  try { h.render(); await h.flush(); h.update({ lockError: 'LOCK_FAILED' }); h.click('✓ Hoàn tất'); assert.match(await h.flush(), /LOCK_FAILED/); assert.equal(h.closed, 0); h.update({ lockError: '' }); h.click('✓ Hoàn tất'); await h.flush(); assert.deepEqual(h.calls.at(-1), { method: 'lock', args: ['project', 'commit-1'] }); assert.equal(h.closed, 1); assert.equal(h.refreshed, 1); assert.match(h.render(), /khóa vĩnh viễn/); assert.doesNotMatch(h.render(), /<textarea/) } finally { h.unmount() }
})

test('partial forms failures retain history and idle interrupted questions release composer', async () => {
  const h = harness(true)
  try { h.update({ session: { status: 'idle' }, formsError: 'FORMS_UNAVAILABLE', items: [{ id: 'answer', role: 'assistant', text: 'History retained' }, { id: 'q', role: 'assistant', kind: 'tool', text: '', tool: { name: 'question', status: 'running' } }] }); h.render(); const html = await h.flush(); assert.match(html, /History retained/); assert.match(html, /FORMS_UNAVAILABLE/); assert.match(html, /Câu hỏi trước đó đã bị gián đoạn/); assert.equal(h.find(node => node.type === 'textarea').props.disabled, false) } finally { h.unmount() }
})

test('disconnected or missing model prevents prompts', async () => {
  for (const offline of [false, true]) {
    const h = harness(false, offline ? {} : { effectiveModelID: undefined })
    try { h.render({ connected: !offline }); await h.flush(); assert.equal(h.find(node => node.type === 'textarea').props.disabled, true) } finally { h.unmount() }
  }
})

// Integration coverage executes Chat's real effects, with the bridge optional for older clients.
function chatHarness(apiOverrides: Record<string, unknown> = {}) {
  const slots: any[] = [], cleanups: (() => void)[] = []
  let cursor = 0, pending: (() => void)[] = [], tree: ReactNode
  const listeners = new Map<string, Set<() => void>>()
  const api = {
    models: async () => [{ id: 'm', providerID: 'amecode', name: 'Model' }],
    commands: async () => [], skills: async () => [], messages: async () => [],
    permissions: async () => [], forms: async () => [], sessionPermissionMode: async () => 'default',
    onEvent: () => () => {}, ...apiOverrides,
  }
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] },
    useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial } },
    useId: () => 'commit-chat-test',
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot() },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const i = cursor++, old = slots[i]
      if (old && deps.length === old.length && deps.every((dep, j) => Object.is(dep, old[j]))) return
      slots[i] = deps; pending.push(() => { cleanups[i]?.(); const cleanup = run(); if (cleanup) cleanups[i] = cleanup })
    },
  }
  const filename = new URL('../components/Chat.tsx', import.meta.url), nativeRequire = createRequire(filename)
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, {
    exports, setTimeout, clearTimeout, requestAnimationFrame() {},
    window: {
      ame: api,
      addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
      removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn) },
    },
    require: (name: string) => name === 'react' ? hooks : name.startsWith('./') ? new Proxy({}, { get: (_target, key) => key === 'errorText' ? (e: Error) => e.message : () => null }) : nativeRequire(name),
  })
  let opened = 0, created = 0
  let props = {
    projectID: 'project', sessionID: 'commit-1', connected: true, ready: true,
    accountRole: 'admin', defaultModelID: 'm', modelLevels: {}, sessions: [], tabs: [], changes: 0, changesStatus: 'ready', theme: 'dark',
    onCreated() {}, onCreate() { created++ }, onOpenCommitAgent() { opened++ }, report() {}, onActivity() {}, onOpenPanel() {}, onOpenFile() {}, onSelectSession() {},
  }
  function render(patch: object = {}) { props = { ...props, ...patch }; cursor = 0; tree = exports.Chat(props); const effects = pending; pending = []; effects.forEach(run => run()); return tree }
  function all(node: ReactNode): ReactElement<Record<string, any>>[] { if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...all(node.props.children)] }
  return {
    render, nodes: () => all(tree),
    emit() { listeners.get('ame-commit-agent-changed')?.forEach(fn => fn()) },
    async flush() { for (let i = 0; i < 3; i++) { await tick(); render() } },
    click(label: string) { const button = all(tree).find(node => node.type === 'button' && node.props.children === label); assert.ok(button); button.props.onClick() },
    get opened() { return opened }, get created() { return created },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); assert.equal([...listeners.values()].reduce((sum, set) => sum + set.size, 0), 0) },
  }
}

test('Chat redirects dedicated commit sessions to the modal, reacts to locks, and restores normal sessions', async () => {
  let lockedSessionIDs: string[] = []
  const h = chatHarness({ commitAgentInfo: async () => ({ commitSessionIDs: ['commit-1'], lockedSessionIDs }) })
  try {
    h.render(); await h.flush()
    const banner = () => h.nodes().find(node => node.props['data-testid'] === 'commit-agent-locked-banner')
    assert.ok(banner()); assert.match(renderToStaticMarkup(banner()), /Đây là phiên Trợ lý Commit AI riêng/)
    assert.equal(h.nodes().some(node => node.type === 'textarea'), false)
    h.click('Trợ lý Commit AI'); h.click('Cuộc trò chuyện mới')
    assert.equal(h.opened, 1); assert.equal(h.created, 1)
    lockedSessionIDs = ['commit-1']; h.emit(); await h.flush()
    assert.match(renderToStaticMarkup(banner()), /đã hoàn tất và được khóa/)
    h.click('Trợ lý Commit AI'); assert.equal(h.opened, 2)
    h.render({ connected: false }); await h.flush()
    assert.ok(banner(), 'disconnect must not unlock a known commit session')
    h.render({ connected: true, sessionID: 'normal' }); await h.flush()
    assert.equal(banner(), undefined); assert.ok(h.nodes().some(node => node.type === 'textarea'))
    h.render({ projectID: 'other', connected: false, sessionID: 'commit-1' })
    assert.equal(banner(), undefined, 'commit metadata cannot leak between projects')
  } finally { h.unmount() }
})

test('Chat remains compatible when commitAgentInfo is absent or rejects', async () => {
  for (const overrides of [{}, { commitAgentInfo: async () => { throw new Error('unavailable') } }]) {
    const h = chatHarness(overrides)
    try { h.render(); await h.flush(); assert.ok(h.nodes().some(node => node.type === 'textarea')); assert.equal(h.nodes().some(node => node.props['data-testid'] === 'commit-agent-locked-banner'), false) } finally { h.unmount() }
  }
})
