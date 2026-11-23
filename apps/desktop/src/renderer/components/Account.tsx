import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, Modal } from './Primitives'
import { formatAmeKitError, formatBundleSize, groupIssues, type IssueSeverity } from '../amekit-ui'

import type { BundleFeatures } from '../../../../../packages/amekit/src/api'

type ActiveModel = { id: string; name: string; vision?: boolean; reasoning?: boolean }
type AccountState = { origin?: string; account?: { name: string; username: string; role?: string }; models?: { default_model?: string; small_model?: string; model_levels?: Partial<Record<'default' | 'haiku' | 'sonnet' | 'opus', string>>; active_models?: ActiveModel[] }; ready?: boolean; reconnecting?: boolean; blocker?: string } | null
type Features = BundleFeatures
type Release = { releaseId?: string; id?: string; version?: string; channel?: string; size?: number; features?: Features; manifest?: { agents?: number; skills?: number; compatibility?: { mode?: string }; features?: Features } }
type Bundle = { version?: string; releaseId?: string; verification?: string; compatibilityWarnings?: unknown[]; compatibilityMode?: string; agents?: string[]; skills?: string[]; fileCount?: number; features?: Features } | null
type ImportPreview = { folderName: string; agents: string[]; skills: string[]; files: { path: string; size: number }[]; issues: unknown[]; compatibilityMode: string; adaptClaudeAgents?: boolean; fixablePaths?: string[] }
type ImportFix = { path: string; summary: string; diff: string; model: string }
type AppliedFix = { path: string; kind: 'ai' | 'excluded'; summary: string; diff?: string; model?: string; saved?: boolean }
type ImportFixResult = { preview?: ImportPreview; fix?: ImportFix; fixes?: ImportFix[]; failed?: { path: string; code: string; detail?: string }[]; excluded?: string; reverted?: string; saved?: string }
function canExcludeImportPath(path: string) { return !!path.trim() && !/^(?:[/\\]|[a-z]:)/i.test(path) && !path.split(/[/\\]/).some(part => part === '..') }
type Packaged = { summary: { version: string; features?: Features }; size: number; entries: number; sha256: string }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function noActiveRelease(error: unknown) { return /\bNO_ACTIVE_RELEASE\b/.test(errorText(error)) }
const releaseID = (release: Release | null) => release?.releaseId || release?.id || ''
const issueLabels: Record<IssueSeverity, string> = { error: 'Lỗi', warning: 'Cảnh báo', change: 'Chuyển đổi', excluded: 'Loại trừ' }
function BundleInventory({ agents, skills }: { agents: string[]; skills: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  if (!agents.length && !skills.length) return null
  const matching = expanded ? skills.filter(skill => skill.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : skills.slice(0, 10)
  return <div className="bundle-inventory">
    <section><h4>Agents ({agents.length})</h4><div className="amekit-badges">{agents.map(agent => <span className="amekit-pill" key={agent}>{agent}</span>)}</div></section>
    <section><div className="amekit-card-heading"><h4>Skills ({skills.length})</h4><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Thu gọn' : 'Xem tất cả / Tìm skill'}</button></div>
      {expanded && <input type="search" aria-label="Tìm skill" placeholder="Tìm skill theo tên..." value={query} onChange={e => setQuery(e.target.value)} />}
      <div className={`amekit-badges${expanded ? ' amekit-skills' : ''}`}>{matching.map(skill => <span className="amekit-pill" key={skill}>{skill}</span>)}</div>
      {expanded && !matching.length && <p className="muted">Không tìm thấy skill phù hợp.</p>}
      {!expanded && skills.length > 10 && <p className="muted">Hiển thị 10 / {skills.length} skills. Mở tìm kiếm để xem tất cả.</p>}
    </section>
  </div>
}
function EnhanceSummary({ features }: { features?: Features }) {
  return <>{(features?.commitEnhanceSkill || features?.commitEnhanceModel) && <span className="amekit-pill">Enhance: {features.commitEnhanceSkill ? `/${features.commitEnhanceSkill}` : 'Conventional Commits'} · {features.commitEnhanceModel || 'default'}</span>}{(features?.androidTranslationSkill || features?.androidTranslationModel) && <span className="amekit-pill">Dịch Android: {features.androidTranslationSkill ? `/${features.androidTranslationSkill}` : 'Chưa chọn skill'} · {features.androidTranslationModel || 'default'}</span>}</>
}
function ReleaseSummary({ release }: { release: Release }) {
  return <p className="muted">{release.manifest?.agents ?? 0} agents · {release.manifest?.skills ?? 0} skills · {formatBundleSize(release.size ?? 0)} <EnhanceSummary features={release.manifest?.features ?? release.features} /></p>
}
export function Account({ projectID, close, embedded = false }: { projectID?: string; close: () => void; embedded?: boolean }) {
  const [account, setAccount] = useState<AccountState>(null)
  const [tab, setTab] = useState('account')
  const [busy, setBusy] = useState(false)
  const [busyOp, setBusyOp] = useState<{ operation: string; path?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [result, setResult] = useState<unknown>(undefined)
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [latest, setLatest] = useState<Release | null>(null)
  const [revision, setRevision] = useState('')
  const [installed, setInstalled] = useState<Bundle>(null)
  const [version, setVersion] = useState('')
  const [mode, setMode] = useState('native')
  const [raw, setRaw] = useState(false)
  const [releases, setReleases] = useState<Release[]>([])
  const [cursor, setCursor] = useState('')
  const [activation, setActivation] = useState('')
  const [noRelease, setNoRelease] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [packaged, setPackaged] = useState<Packaged | null>(null)
  const [commitEnhanceSkill, setCommitEnhanceSkill] = useState('')
  const [commitEnhanceModel, setCommitEnhanceModel] = useState('')
  const [androidTranslationSkill, setAndroidTranslationSkill] = useState('')
  const [androidTranslationModel, setAndroidTranslationModel] = useState('')
  const [publishNotice, setPublishNotice] = useState('')
  const [appliedFixes, setAppliedFixes] = useState<Record<string, AppliedFix>>({})
  const [fixNotice, setFixNotice] = useState('')
  const [issueTab, setIssueTab] = useState<IssueSeverity>('excluded')
  const [activeReleaseId, setActiveReleaseId] = useState('')
  const isAdmin = account?.account?.role === 'admin' || account?.account?.role === 'owner'
  const grouped = groupIssues(importPreview?.issues ?? [], importPreview?.compatibilityMode)
  const fixableErrors = [...new Set(grouped.error.map(issue => issue.path).filter(path => importPreview?.fixablePaths?.includes(path)))]
  const defaultModelID = account?.models?.model_levels?.default || account?.models?.default_model || ''
  const modelLevels = {
    default: defaultModelID,
    haiku: account?.models?.model_levels?.haiku || account?.models?.small_model || defaultModelID,
    sonnet: account?.models?.model_levels?.sonnet || defaultModelID,
    opus: account?.models?.model_levels?.opus || defaultModelID,
  }
  const activeModels = account?.models?.active_models ?? []
  const selectableModels = account?.models?.active_models ?? [...new Set(Object.values(modelLevels).filter(Boolean))].map(id => ({ id, name: id }))
  const modelOptions = (selected: string) => <><option value="">Mặc định theo API (default · {defaultModelID || '—'})</option>{selected && !selectableModels.some(model => model.id === selected) && <option value={selected}>{selected} · Không còn hoạt động</option>}{selectableModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</>
  const resetFeatures = () => { setCommitEnhanceSkill(''); setCommitEnhanceModel(''); setAndroidTranslationSkill(''); setAndroidTranslationModel('') }
  const formatted = error ? formatAmeKitError(error) : undefined
  const blockerInfo = account?.blocker ? formatAmeKitError(account.blocker) : undefined
  const bundleGeneration = useRef(0)
  const historyGeneration = useRef(0)
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  // AmeKit's main-process service accepts only one operation at a time.
  const request = useCallback((operation: string, payload?: Record<string, string>) => {
    const next = pending.current.then(async () => {
      const value = await window.ame.account(operation, payload)
      if (['status', 'login', 'refresh', 'logout', 'sync', 'offline', 'uninstall'].includes(operation)) window.dispatchEvent(new Event('ame-account-changed'))
      return value
    })
    pending.current = next.catch(() => {})
    return next
  }, [])
  const applyHistory = useCallback((value: unknown, append = false) => {
    const data = object(value), active = object(data.active)
    const rows = Array.isArray(data.releases) ? data.releases as Release[] : []
    setReleases(old => append ? [...old.filter(release => !rows.some(row => releaseID(row) === releaseID(release))), ...rows] : rows)
    setCursor(typeof data.nextCursor === 'string' ? data.nextCursor : '')
    setActiveReleaseId(typeof active.release_id === 'string' ? active.release_id : '')
    if (active.revision !== undefined) setRevision(String(active.revision))
  }, [])
  useEffect(() => {
    if (tab !== 'admin' || !isAdmin) return
    let alive = true
    const generation = ++historyGeneration.current
    const current = () => alive && generation === historyGeneration.current
    setBusy(true); setError('')
    void request('history').then(value => { if (current()) applyHistory(value) })
      .catch(e => { if (current()) setError(errorText(e)) })
      .finally(() => { if (current()) setBusy(false) })
    return () => { alive = false; if (generation === historyGeneration.current) { historyGeneration.current++; setBusy(false) } }
  }, [tab, isAdmin, request, applyHistory])
  useEffect(() => {
    if (tab !== 'bundle' || !account?.account) return
    let alive = true
    const generation = ++bundleGeneration.current
    const current = () => alive && generation === bundleGeneration.current
    setBusy(true); setError(''); setLatest(null); setInstalled(null); setNoRelease(false)
    void (async () => {
      if (projectID) {
        try { const value = await request('installed', { project: projectID }); if (current()) setInstalled(value as Bundle) }
        catch (e) { if (current()) setError(errorText(e)) }
      }
      if (!current()) return
      try {
        const data = object(await request('latest'))
        if (current()) { const release = object(data.release) as Release; setLatest(release); setActiveReleaseId(releaseID(release)); setRevision(String(data.revision ?? '')) }
      } catch (e) {
        if (current()) {
          setLatest(null)
          if (noActiveRelease(e)) { setActiveReleaseId(''); setNoRelease(true) }
          else setError(errorText(e))
        }
      }
    })().finally(() => { if (current()) setBusy(false) })
    return () => { alive = false; if (generation === bundleGeneration.current) { bundleGeneration.current++; setBusy(false) } }
  }, [tab, account?.account, projectID, request])
  useEffect(() => {
    let alive = true
    void request('status').then(value => { if (alive) setAccount(value as AccountState) }).catch(e => { if (alive) setError(errorText(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [request])
  useEffect(() => {
    setCommitEnhanceSkill(skill => importPreview?.skills.includes(skill) ? skill : '')
    setAndroidTranslationSkill(skill => importPreview?.skills.includes(skill) ? skill : '')
  }, [importPreview])
  const execute = async (operation: string, payload?: Record<string, string>) => {
    setBusy(true); setBusyOp({ operation, path: payload?.path }); setError(''); setResult(undefined)
    const importOperation = ['fix-import', 'fix-import-all', 'exclude-import-file', 'revert-import-fix', 'save-import-fix'].includes(operation)
    if (importOperation) setFixNotice('')
    if (operation === 'package') setPackaged(null)
    try {
      const value = await request(operation, payload)
      if (['status', 'login', 'refresh', 'logout'].includes(operation)) {
        setAccount(value as AccountState); setPassword('')
        if (operation === 'logout') {
          setImportPreview(null); setPackaged(null); setPublishNotice(''); setLatest(null); setInstalled(null); resetFeatures(); setAppliedFixes({}); setFixNotice('')
          setReleases([]); setCursor(''); setActiveReleaseId(''); setActivation(''); setRevision(''); setNoRelease(false); setTab('account')
        }
      } else {
        setResult(value)
        if (operation === 'import' && value) {
          const preview = value as ImportPreview
          setPackaged(null); setPublishNotice(''); setAppliedFixes({}); setFixNotice('')
          let features: Features = {}
          if (preview) {
            try {
              const data = object(await request('latest')), release = object(data.release) as Release
              setLatest(release)
              features = release.manifest?.features ?? release.features ?? {}
            } catch { /* Import remains usable without an active or reachable release. */ }
          }
          setImportPreview(preview)
          setCommitEnhanceSkill(features.commitEnhanceSkill && preview?.skills.includes(features.commitEnhanceSkill) ? features.commitEnhanceSkill : '')
          setCommitEnhanceModel(features.commitEnhanceModel ?? '')
          setAndroidTranslationSkill(features.androidTranslationSkill && preview?.skills.includes(features.androidTranslationSkill) ? features.androidTranslationSkill : '')
          setAndroidTranslationModel(features.androidTranslationModel ?? '')
          setIssueTab(groupIssues(preview?.issues ?? [], preview?.compatibilityMode).defaultTab)
        }
        if (importOperation) {
          const data = value as ImportFixResult
          setPackaged(null); setPublishNotice('')
          if (data.preview) {
            setImportPreview(data.preview)
            setIssueTab(groupIssues(data.preview.issues, data.preview.compatibilityMode).defaultTab)
          }
          setAppliedFixes(old => {
            const next = { ...old }
            for (const fix of data.fixes ?? (data.fix ? [data.fix] : [])) next[fix.path] = { ...fix, kind: 'ai', saved: false }
            if (data.excluded) next[data.excluded] = { path: data.excluded, kind: 'excluded', summary: 'Tệp đã được bỏ khỏi gói tạm; tệp nguồn trên đĩa không bị xóa.' }
            if (data.reverted) delete next[data.reverted]
            if (data.saved && next[data.saved]) next[data.saved] = { ...next[data.saved], saved: true }
            return next
          })
          if (operation === 'fix-import-all') {
            const failed = data.failed ?? []
            setFixNotice(`Đã sửa ${data.fixes?.length ?? 0} tệp bằng AI.${failed.length ? ` Không sửa được ${failed.length} tệp: ${failed.map(item => `${item.path} — ${formatAmeKitError(item.code).title}${item.detail ? `: ${item.detail}` : ''}`).join('; ')}.` : ''}${fixableErrors.length > 10 ? ' Mỗi lần sửa tối đa 10 tệp; chạy lại để xử lý các lỗi còn lại.' : ''}`)
          } else if (data.fix) setFixNotice(`Đã sửa ${data.fix.path} bằng AI và kiểm tra lại thành công.`)
          else if (data.excluded) setFixNotice(`Đã bỏ ${data.excluded} khỏi gói tạm.`)
          else if (data.reverted) setFixNotice(`Đã khôi phục ${data.reverted} về nội dung lúc nhập; tệp trên đĩa không thay đổi.`)
          else if (data.saved) setFixNotice(`Đã lưu ${data.saved} vào thư mục gốc.`)
        }
        if (operation === 'package') setPackaged(value as Packaged)
        if (operation === 'latest' || operation === 'activate') {
          const data = object(value), release = object(data.release) as Release
          setLatest(release); setActiveReleaseId(releaseID(release)); setNoRelease(false); setRevision(String(data.revision ?? ''))
          if (operation === 'activate') { setActivation(releaseID(release)); setPublishNotice(`Đã kích hoạt v${release.version || releaseID(release)} cho team.`) }
        }
        if (operation === 'publish') {
          const published = value as Release, id = releaseID(published)
          setPackaged(null); setPublishNotice(`Đã xuất bản v${published.version || id}. Chọn Kích hoạt ở Bước 3 để áp dụng cho team.`)
          setActivation(id)
          setReleases(old => [published, ...old.filter(release => releaseID(release) !== id)])
          const history = await request('history')
          applyHistory(history)
          setReleases(old => old.some(release => releaseID(release) === id) ? old : [published, ...old])
        }
        if (operation === 'installed') setInstalled(value as Bundle)
        if (operation === 'sync' || operation === 'offline') setInstalled(value as Bundle)
        if (operation === 'uninstall') setInstalled(await request('installed', { project: projectID! }) as Bundle)
        if (operation === 'history') applyHistory(value, !!payload?.cursor)
      }
    } catch (e) {
      if (operation === 'latest' && noActiveRelease(e)) { setLatest(null); setActiveReleaseId(''); setNoRelease(true) }
      else {
        setError(errorText(e))
        if (operation === 'activate' && /\bACTIVATION_CONFLICT\b/.test(errorText(e))) {
          try { applyHistory(await request('history')) } catch { /* Keep the original actionable activation error. */ }
        }
      }
    } finally { setBusy(false); setBusyOp(null) }
  }
  const content = <><div className="segmented account-tabs"><button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>Tài khoản</button><button className={tab === 'bundle' ? 'active' : ''} onClick={() => setTab('bundle')}>Bundle</button>{isAdmin && <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>Quản trị</button>}</div><div className="settings-content">
    {formatted && <div className="amekit-alert amekit-alert--error" role="alert"><strong>{formatted.title}</strong>{formatted.detail && <p>{formatted.detail}</p>}{formatted.code && <small>Mã: {formatted.code}</small>}</div>}
    {loading ? <p>Đang đọc tài khoản…</p> : tab === 'account' ? <>{account?.account ? <>
      <section className="amekit-profile-card">
        <div className="profile-avatar" aria-hidden="true">{(account.account.name || account.account.username).trim().charAt(0).toLocaleUpperCase()}</div>
        <div className="amekit-profile-card__identity"><h3>{account.account.name || account.account.username}</h3><p>@{account.account.username}</p><p className="muted">{account.origin}</p></div>
        <span className="amekit-pill amekit-profile-card__role">{account.account.role || 'member'}</span>
      </section>
      <div className={`amekit-alert ${account.ready ? 'amekit-alert--success' : 'amekit-alert--warning'}`} role="status"><strong>{account.ready ? 'Tài khoản sẵn sàng' : blockerInfo?.title || (account.reconnecting ? 'Đang kết nối lại…' : 'Tài khoản chưa sẵn sàng')}</strong>{!account.ready && blockerInfo?.detail && <p>{blockerInfo.detail}</p>}</div>
      {(account.models?.model_levels || account.models?.default_model) && <section className="amekit-card amekit-model-levels"><h4>Phân cấp Model từ API</h4><dl>{Object.entries(modelLevels).map(([level, id]) => <div key={level}><dt><code>{level}</code></dt><dd><code>{id || '—'}</code></dd></div>)}</dl></section>}
      {activeModels.length > 0 && <section className="amekit-card amekit-active-models" data-testid="amekit-active-models"><h4>Tất cả Model đang hoạt động từ API ({activeModels.length})</h4><ul>{activeModels.map(model => <li key={model.id}><strong>{model.name}</strong> <code>{model.id}</code>{model.vision && <span className="amekit-pill">Vision</span>}{model.reasoning && <span className="amekit-pill">Reasoning</span>}</li>)}</ul></section>}
      <div className="button-row"><button disabled={busy} onClick={() => void execute('refresh')}>Làm mới phiên</button><button disabled={busy} onClick={() => void execute('logout')}>Đăng xuất</button></div>
    </> : <form onSubmit={e => { e.preventDefault(); void execute('login', { ...(server.trim() ? { server: server.trim() } : {}), username, password }) }}>
      {account?.reconnecting ? <div className="amekit-alert amekit-alert--warning" role="status"><strong>{blockerInfo?.title || 'Đang kết nối lại tài khoản đã lưu…'}</strong>{blockerInfo?.detail && <p>{blockerInfo.detail}</p>}<div className="button-row"><button type="button" disabled={busy} onClick={() => void execute('refresh')}>Kết nối lại</button><button type="button" disabled={busy} onClick={() => void execute('logout')}>Đăng xuất tài khoản đã lưu</button></div></div> : blockerInfo && <div className="amekit-alert amekit-alert--warning" role="status"><strong>{blockerInfo.title}</strong>{blockerInfo.detail && <p>{blockerInfo.detail}</p>}</div>}
      <p className="muted">Thông tin đăng nhập được bảo vệ bởi kho khóa bảo mật của hệ thống.</p>
      <label>Máy chủ (tùy chọn)<input type="url" placeholder="https://amecode.ameno.tech" value={server} onChange={e => setServer(e.target.value)} /></label>
      <label>Tên đăng nhập<input required autoComplete="username" placeholder="Nhập tên đăng nhập" value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>Mật khẩu<input required type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <div className="button-row"><button className="primary" disabled={busy}>Đăng nhập</button>{account?.blocker && <button type="button" disabled={busy} onClick={() => void execute('status')}>Kiểm tra lại</button>}</div>
    </form>}</> : tab === 'bundle' ? <>
      <p className="muted">{projectID ? 'Các thao tác áp dụng cho dự án đang chọn.' : 'Chọn dự án trước khi cài bundle.'}</p>
      <section className="amekit-card"><h3>Bản phát hành trên máy chủ</h3>
        <div className="button-row"><button disabled={busy} onClick={() => void execute('latest')}>Bản mới nhất</button><button disabled={busy || !projectID} onClick={() => void execute('installed', { project: projectID! })}>Kiểm tra đã cài</button></div>
        {latest && <><div className="amekit-badges"><strong>v{latest.version || releaseID(latest)}</strong><span>{latest.channel}</span><span className="amekit-pill">{latest.manifest?.compatibility?.mode || 'native'}</span><span className="amekit-pill">{installed?.releaseId === releaseID(latest) ? 'Đã khớp bản mới nhất' : installed ? 'Có bản mới trên máy chủ' : 'Chưa cài'}</span></div><ReleaseSummary release={latest} /></>}
        {noRelease && <p className="muted">Máy chủ chưa có bản phát hành nào được kích hoạt.</p>}
      </section>
      <section className="amekit-card"><h3>Bundle đang cài trong dự án</h3>
        {installed ? <><div className="amekit-badges"><strong>v{installed.version || installed.releaseId}</strong><span className="amekit-pill">{installed.compatibilityMode || 'native'}</span><EnhanceSummary features={installed.features} /></div><p>{installed.verification === 'runtime-ready' ? 'Sẵn sàng OpenCode' : 'Đã xác minh chữ ký/byte'} · {installed.fileCount ?? 0} tệp</p><BundleInventory agents={installed.agents || []} skills={installed.skills || []} /></> : <p className="muted">Dự án này chưa cài bundle nào.</p>}
      </section>
      {latest?.manifest?.compatibility?.mode === 'raw' && !raw && <div className="amekit-alert amekit-alert--warning">Bản phát hành mới nhất dùng chế độ Raw — chỉ xác minh byte, không xác minh tương thích runtime. Bật tùy chọn bên dưới trước khi đồng bộ.</div>}
      <label className="checkbox"><input type="checkbox" checked={raw} onChange={e => setRaw(e.target.checked)} />Cho phép raw compatibility khi đồng bộ</label>
      <div className="button-row"><button className="primary" disabled={busy || !projectID} onClick={() => void execute('sync', { project: projectID!, ...(raw ? { allowRaw: 'true' } : {}) })}>Đồng bộ mới nhất</button><button disabled={busy || !projectID} onClick={() => void execute('offline', { project: projectID! })}>Kiểm tra tệp đã cài (offline)</button><button disabled={busy || !projectID} onClick={() => void execute('uninstall', { project: projectID! })}>Gỡ bundle</button></div>
      <p className="muted">Các thay đổi tệp được xác nhận bằng hộp thoại native.</p>
    </> : isAdmin ? <>
      {publishNotice && <div className="amekit-alert amekit-alert--success" role="status">{publishNotice}</div>}
      <section className="amekit-card"><h3>Bước 1 · Chọn &amp; kiểm tra thư mục</h3>
        <label>Chế độ tương thích<select disabled={busy} value={mode} onChange={e => setMode(e.target.value)}><option value="native">Native (Chuẩn OpenCode 2.3.2 nghiêm ngặt)</option><option value="raw-adapt">Raw + Chuẩn hóa agent Claude -&gt; OpenCode (khuyên dùng cho gói Claude)</option><option value="raw">Raw (Giữ nguyên byte gốc)</option></select></label>
        <button disabled={busy} onClick={() => void execute('import', { compatibilityMode: mode === 'raw-adapt' ? 'raw' : mode, ...(mode === 'raw-adapt' ? { adaptClaudeAgents: 'true' } : {}) })}>{busyOp?.operation === 'import' ? 'Đang quét thư mục…' : 'Chọn thư mục & nhập'}</button>
        {importPreview && <div className="amekit-inspector">
          <div className="amekit-badges"><strong className="amekit-pill">{importPreview.folderName}</strong><span className="amekit-pill">{importPreview.adaptClaudeAgents ? 'raw-adapt' : importPreview.compatibilityMode}</span><span className={`amekit-pill ${grouped.error.length ? 'amekit-readiness--blocked' : 'amekit-readiness--ready'}`}>{grouped.error.length ? `Bị chặn · ${grouped.error.length} lỗi` : 'Sẵn sàng đóng gói'}</span></div>
          <p className="amekit-stats">{importPreview.agents.length} agents · {importPreview.skills.length} skills · {importPreview.files.length} tệp · {formatBundleSize(importPreview.files.reduce((sum, file) => sum + file.size, 0))}</p>
          {grouped.suggestClaudeAdapt && mode === 'native' && <div className="amekit-alert amekit-alert--warning"><strong>Phát hiện frontmatter agent Claude không tương thích Native.</strong><p>Các trường tools, model: inherit, color cần được chuẩn hóa cho OpenCode. Chuyển chế độ rồi chọn nhập lại thư mục để kiểm tra.</p><button disabled={busy} onClick={() => setMode('raw-adapt')}>Chuyển sang "Raw + Chuẩn hóa agent Claude"</button></div>}
          {mode !== (importPreview.adaptClaudeAgents ? 'raw-adapt' : importPreview.compatibilityMode) && <p className="muted">Chế độ mới chỉ áp dụng lần nhập tiếp theo. Chọn thư mục &amp; nhập lại để cập nhật kết quả.</p>}
          <BundleInventory agents={importPreview.agents} skills={importPreview.skills} />
          {grouped.error.length > 0 && <div className="amekit-fix-bar">
            <span className="amekit-pill" data-testid="amekit-fix-model">Model sửa lỗi (agent &amp; skill): default{defaultModelID ? ` · ${defaultModelID}` : ''}</span>
            <p>Sửa trực tiếp các tệp agent &amp; skill bị lỗi bằng model mặc định theo API (<code>default</code>{defaultModelID ? <>: <code>{defaultModelID}</code></> : ''}); secret nhạy cảm được ẩn tự động trước khi gửi lên AI.</p>
            {fixableErrors.length > 0 && <button type="button" disabled={busy} onClick={() => void execute('fix-import-all', {})}>{busyOp?.operation === 'fix-import-all' ? 'Đang sửa bằng AI…' : fixableErrors.length > 1 ? `Sửa tất cả lỗi bằng AI (${fixableErrors.length})` : 'Sửa lỗi bằng AI'}</button>}
            {(busyOp?.operation === 'fix-import' || busyOp?.operation === 'fix-import-all') && <div className="amekit-busy-inline" role="status">
              <span className="amekit-spinner" aria-hidden="true" />
              <span>{busyOp.path ? `Đang sửa ${busyOp.path}` : 'Đang sửa bằng AI'} bằng model default{defaultModelID ? ` (${defaultModelID})` : ''}…</span>
            </div>}
          </div>}
          {fixNotice && <p className={/Không sửa được|0 tệp/.test(fixNotice) ? 'amekit-alert amekit-alert--error' : 'amekit-fix-notice'} role={/Không sửa được|0 tệp/.test(fixNotice) ? 'alert' : 'status'}>{fixNotice}</p>}
          <div className="amekit-issue-tabs" role="tablist" aria-label="Phân loại vấn đề">{(Object.keys(issueLabels) as IssueSeverity[]).map(severity => <button key={severity} id={`amekit-issue-${severity}`} role="tab" aria-selected={issueTab === severity} aria-controls="amekit-issue-panel" onClick={() => setIssueTab(severity)}>{issueLabels[severity]} ({grouped[severity].length})</button>)}</div>
          <div id="amekit-issue-panel" className="amekit-issues" role="tabpanel" aria-labelledby={`amekit-issue-${issueTab}`} tabIndex={0}>{grouped[issueTab].length ? <ul>{grouped[issueTab].map((issue, index) => <li className="amekit-issue-row" key={index}><code>{issue.path || 'Bundle'}</code><span>{issue.reason}</span>{issueTab === 'error' && issue.path && <div className="amekit-issue-actions">{importPreview.fixablePaths?.includes(issue.path) && <button type="button" disabled={busy} onClick={() => void execute('fix-import', { path: issue.path })}>{busyOp?.operation === 'fix-import' && busyOp.path === issue.path ? 'Đang sửa…' : 'Sửa bằng AI'}</button>}{canExcludeImportPath(issue.path) && <button type="button" disabled={busy} onClick={() => void execute('exclude-import-file', { path: issue.path })}>Bỏ tệp</button>}</div>}</li>)}</ul> : <p className="muted">Không có mục nào trong nhóm này.</p>}</div>
          {Object.keys(appliedFixes).length > 0 && <div className="amekit-fix-list"><p className="muted">Các bản sửa đang áp dụng tạm để đóng gói (chưa ghi đè thư mục gốc nếu chưa bấm Lưu).</p>{Object.values(appliedFixes).map(fix => <article className="amekit-fix-card" key={fix.path}>
            <div className="amekit-badges"><code>{fix.path}</code><span className="amekit-pill">{fix.kind === 'ai' ? `Đã sửa bởi AI · default (${fix.model})` : 'Đã bỏ khỏi gói'}</span></div>
            <p>{fix.summary}</p>
            {fix.diff && <details><summary>Xem thay đổi (diff)</summary><pre className="amekit-fix-diff">{fix.diff}</pre></details>}
            <div className="amekit-issue-actions">{fix.kind === 'ai' && <button type="button" disabled={busy || fix.saved} onClick={() => void execute('save-import-fix', { path: fix.path })}>{fix.saved ? 'Đã lưu vào đĩa' : 'Lưu về thư mục gốc'}</button>}<button type="button" disabled={busy} title="Khôi phục gói tạm; không thay đổi tệp đã lưu trên đĩa" onClick={() => void execute('revert-import-fix', { path: fix.path })}>Hoàn tác</button></div>
          </article>)}</div>}
        </div>}
      </section>
      <section className="amekit-card"><h3>Bước 2 · Đóng gói ZIP &amp; Xuất bản lên máy chủ</h3>
        <form onSubmit={e => { e.preventDefault(); if (!busy && version.trim() && importPreview && !grouped.error.length) void execute('package', { version: version.trim(), ...(commitEnhanceSkill ? { commitEnhanceSkill } : {}), ...(commitEnhanceModel ? { commitEnhanceModel } : {}), ...(androidTranslationSkill ? { androidTranslationSkill } : {}), ...(androidTranslationModel ? { androidTranslationModel } : {}) }) }}>
          <label>Phiên bản<input value={version} required placeholder="1.0.0" disabled={busy} onChange={e => setVersion(e.target.value)} /></label>
          {importPreview && <>
            <fieldset className="amekit-feature-config"><legend>Enhance (Commit message)</legend>
              <label>Skill cho Enhance (Commit message)<select aria-label="Skill cho Enhance (Commit message)" disabled={busy} value={commitEnhanceSkill} onChange={e => { setCommitEnhanceSkill(e.target.value); setPackaged(null) }}><option value="">Mặc định (Conventional Commits)</option>{importPreview.skills.map(skill => <option key={skill} value={skill}>/{skill}</option>)}</select></label>
              <label>Model cho Enhance (Commit message)<select aria-label="Model cho Enhance (Commit message)" disabled={busy} value={commitEnhanceModel} onChange={e => { setCommitEnhanceModel(e.target.value); setPackaged(null) }}>{modelOptions(commitEnhanceModel)}</select></label>
              <p className="muted">Nút Enhance của mọi thành viên tự dùng skill và model đã chọn sau khi kích hoạt và đồng bộ bundle.</p>
            </fieldset>
            <fieldset className="amekit-feature-config"><legend>Dịch Android (Strings translation)</legend>
              <label>Skill cho Dịch Android<select aria-label="Skill cho Dịch Android" disabled={busy} value={androidTranslationSkill} onChange={e => { setAndroidTranslationSkill(e.target.value); setPackaged(null) }}><option value="">Không bật</option>{importPreview.skills.map(skill => <option key={skill} value={skill}>/{skill}</option>)}</select></label>
              <label>Model cho Dịch Android<select aria-label="Model cho Dịch Android" disabled={busy || !androidTranslationSkill} value={androidTranslationModel} onChange={e => { setAndroidTranslationModel(e.target.value); setPackaged(null) }}>{modelOptions(androidTranslationModel)}</select></label>
              <p className="muted">Dịch strings.xml trong phiên riêng; Chat chính vẫn dùng model theo chính sách tài khoản.</p>
            </fieldset>
          </>}
          <div className="button-row"><button disabled={busy || !version.trim() || !importPreview || grouped.error.length > 0}>Đóng gói</button><button type="button" className={packaged ? 'primary' : ''} disabled={busy || !packaged} onClick={() => void execute('publish')}>Xuất bản gói đã chuẩn bị</button></div>
        </form>
        {importPreview && grouped.error.length > 0 && <p className="amekit-alert amekit-alert--warning">Đóng gói bị khóa. Hãy sửa hoặc bỏ các tệp lỗi ở Bước 1; kết quả được kiểm tra lại ngay.</p>}
        {packaged && <p className="amekit-package-summary">Đã đóng gói v{packaged.summary.version} · {formatBundleSize(packaged.size)} · {packaged.entries} mục · SHA-256 <code>{packaged.sha256}</code> <EnhanceSummary features={packaged.summary.features} /></p>}
      </section>
      <section className="amekit-card"><div className="amekit-card-heading"><h3>Bước 3 · Bản phát hành &amp; Kích hoạt cho team</h3><div className="button-row"><button disabled={busy} onClick={() => void execute('history')}>Làm mới lịch sử</button>{cursor && <button disabled={busy} onClick={() => void execute('history', { cursor })}>Trang tiếp</button>}</div></div>
        <p className="muted">Revision hiện tại: {revision || '—'}</p>
        {!releases.length && <p className="muted">Chưa có bản phát hành nào trên máy chủ.</p>}
        <div className="amekit-releases">{releases.map(release => { const id = releaseID(release); return <article className="amekit-release" key={id}><div className="amekit-card-heading"><div className="amekit-badges"><strong>v{release.version || id}</strong>{activeReleaseId === id && <span className="amekit-pill amekit-readiness--ready">Đang kích hoạt</span>}<span className="amekit-pill">{release.manifest?.compatibility?.mode || 'native'}</span></div>{activeReleaseId !== id && <button disabled={busy || !revision} onClick={() => void execute('activate', { id, revision })}>Kích hoạt</button>}</div><ReleaseSummary release={release} /></article> })}</div>
        <details className="amekit-activation"><summary>Kích hoạt release theo lựa chọn</summary><label>Release<select value={activation} onChange={e => setActivation(e.target.value)}><option value="">Chọn release</option>{releases.map(release => { const id = releaseID(release); return <option key={id} value={id}>{release.version || id} · {release.channel}</option> })}</select></label><label>Revision hiện tại<input value={revision} onChange={e => setRevision(e.target.value)} /></label><button disabled={busy || !activation || !revision} onClick={() => void execute('activate', { id: activation, revision })}>Kích hoạt release</button></details>
      </section>
    </> : <p>Chỉ quản trị viên có thể quản lý release.</p>}
    {busy && !['import', 'fix-import', 'fix-import-all'].includes(busyOp?.operation ?? '') && <p role="status">Đang xử lý…</p>}
    {result !== undefined && <details key={JSON.stringify(result)} className="operation-result"><summary>Chi tiết kỹ thuật (JSON)</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
  </div></>
  const core = <section className="amekit-core" aria-label="AmeKit">{content}</section>
  return embedded ? core : <Modal title="AmeKit" close={close}>{core}</Modal>
}
