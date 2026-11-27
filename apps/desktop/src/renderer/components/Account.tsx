import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, Modal } from './Primitives'
import { formatAmeKitError, formatBundleSize, formatCatalogVersion, formatSemverVersion, formatVersionSummaryLine, groupIssues, suggestNextVersion, type IssueSeverity } from '../amekit-ui'

import type { BundleFeatures } from '../../../../../packages/amekit/src/api'

type ActiveModel = { id: string; name: string; vision?: boolean; reasoning?: boolean }
type AccountState = { origin?: string; account?: { name: string; username: string; role?: string }; orchestrator?: { id?: string; version?: string }; models?: { version?: string; default_model?: string; small_model?: string; model_levels?: Partial<Record<'default' | 'haiku' | 'sonnet' | 'opus', string>>; active_models?: ActiveModel[] }; refreshedAt?: number; bundle?: { installedVersion?: string; installedReleaseId?: string; installedFeatures?: BundleFeatures; latestVersion?: string; latestReleaseId?: string; checkedAt?: number; autoSyncError?: string }; ready?: boolean; reconnecting?: boolean; blocker?: string; bundleAutoSyncError?: string } | null
type Features = BundleFeatures
type Release = { releaseId?: string; id?: string; version?: string; channel?: string; size?: number; features?: Features; manifest?: { agents?: number; skills?: number; compatibility?: { mode?: string }; features?: Features } }
type Bundle = { version?: string; releaseId?: string; verification?: string; compatibilityWarnings?: unknown[]; compatibilityMode?: string; agents?: string[]; skills?: string[]; fileCount?: number; features?: Features } | null
type LegacyProjectBundle = { projectName?: string; version?: string; releaseId?: string; fileCount: number; hasConfigDir: boolean; hasManagedDir: boolean; modified?: boolean; error?: string } | null
type ImportPreview = { folderName: string; agents: string[]; skills: string[]; files: { path: string; size: number }[]; issues: unknown[]; compatibilityMode: string; adaptClaudeAgents?: boolean; fixablePaths?: string[] }
type ImportFix = { path: string; summary: string; diff: string; model: string }
type AppliedFix = { path: string; kind: 'ai' | 'excluded'; summary: string; diff?: string; model?: string; saved?: boolean }
type ImportFixResult = { preview?: ImportPreview; fix?: ImportFix; fixes?: ImportFix[]; failed?: { path: string; code: string; detail?: string }[]; excluded?: string; reverted?: string; saved?: string }
function canExcludeImportPath(path: string) { return !!path.trim() && !/^(?:[/\\]|[a-z]:)/i.test(path) && !path.split(/[/\\]/).some(part => part === '..') }
type Packaged = { summary: { version: string; features?: Features }; size: number; entries: number; sha256: string }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function noActiveRelease(error: unknown) { return /\bNO_ACTIVE_RELEASE\b/.test(errorText(error)) }
const releaseID = (release: Release | null) => release?.releaseId || release?.id || ''
const normalizeFeatures = (f: Features) => ({
  commitEnhanceSkill: f.commitEnhanceSkill?.trim() || '',
  commitEnhanceModel: f.commitEnhanceModel?.trim() || '',
  androidTranslationSkill: f.androidTranslationSkill?.trim() || '',
  androidTranslationModel: f.androidTranslationModel?.trim() || '',
  buildNotesSkill: f.buildNotesSkill?.trim() || '',
  buildNotesModel: f.buildNotesModel?.trim() || '',
})
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
  return <>{(features?.commitEnhanceSkill || features?.commitEnhanceModel) && <span className="amekit-pill">Enhance: {features.commitEnhanceSkill ? `/${features.commitEnhanceSkill}` : 'Conventional Commits'} · {features.commitEnhanceModel || 'default'}</span>}{(features?.androidTranslationSkill || features?.androidTranslationModel) && <span className="amekit-pill">Dịch Android: {features.androidTranslationSkill ? `/${features.androidTranslationSkill}` : 'Chưa chọn skill'} · {features.androidTranslationModel || 'default'}</span>}{(features?.buildNotesSkill || features?.buildNotesModel) && <span className="amekit-pill">Build Notes: {features.buildNotesSkill ? `/${features.buildNotesSkill}` : 'Mặc định QC'} · {features.buildNotesModel || 'default'}</span>}</>
}
function ReleaseSummary({ release }: { release: Release }) {
  return <p className="muted">{release.manifest?.agents ?? 0} agents · {release.manifest?.skills ?? 0} skills · {formatBundleSize(release.size ?? 0)} <EnhanceSummary features={release.manifest?.features ?? release.features} /></p>
}
export function Account({ projectID, close, embedded = false }: { projectID?: string; close: () => void; embedded?: boolean }) {
  const [account, setAccount] = useState<AccountState>(null)
  const [tab, updateTab] = useState('account')
  const [adminTab, updateAdminTab] = useState<'publish' | 'features' | 'history'>('publish')
  const [errorState, setErrorState] = useState<{ scope: 'global' | 'source' | 'release' | 'features' | 'history'; message: string } | null>(null)
  const setTab = (value: string) => { setErrorState(null); setBundleNotice(''); updateTab(value) }
  const setAdminTab = (value: 'publish' | 'features' | 'history') => { setErrorState(null); updateAdminTab(value) }
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [busyOp, setBusyOp] = useState<{ operation: string; path?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [bundleLoading, setBundleLoading] = useState(false)
  const [bundleLoaded, setBundleLoaded] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const lastLegacyProject = useRef(projectID)
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [latest, setLatest] = useState<Release | null>(null)
  const [revision, setRevision] = useState('')
  const [installed, setInstalled] = useState<Bundle>(null)
  const [legacyInfo, setLegacyInfo] = useState<LegacyProjectBundle>(null)
  const [bundleNotice, setBundleNotice] = useState('')
  const [refreshNotice, setRefreshNotice] = useState('')
  const [editingVersion, setEditingVersion] = useState(false)
  const [customVersion, setCustomVersion] = useState('')
  const [activateNow, setActivateNow] = useState(true)
  const [mode, updateMode] = useState(() => {
    try {
      const saved = window.localStorage?.getItem('ame.amekit.importMode')
      if (saved === 'native' || saved === 'raw-adapt' || saved === 'raw') return saved
    } catch { /* Storage may be unavailable in restricted environments. */ }
    return 'raw-adapt'
  })
  const setMode = (value: string) => {
    updateMode(value)
    try { window.localStorage?.setItem('ame.amekit.importMode', value) } catch { /* Keep the selection even without storage. */ }
  }
  const [releases, setReleases] = useState<Release[]>([])
  const [cursor, setCursor] = useState('')
  const [noRelease, setNoRelease] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [packaged, setPackaged] = useState<Packaged | null>(null)
  const [commitEnhanceSkill, setCommitEnhanceSkill] = useState('')
  const [commitEnhanceModel, setCommitEnhanceModel] = useState('')
  const [androidTranslationSkill, setAndroidTranslationSkill] = useState('')
  const [androidTranslationModel, setAndroidTranslationModel] = useState('')
  const [buildNotesSkill, setBuildNotesSkill] = useState('')
  const [buildNotesModel, setBuildNotesModel] = useState('')
  const [serverFeaturesRelease, setServerFeaturesRelease] = useState<Release | null>(null)
  const [serverSkills, setServerSkills] = useState<string[]>([])
  const [serverBaseFeatures, setServerBaseFeatures] = useState<Features>({})
  const [serverFeaturesLoading, setServerFeaturesLoading] = useState(false)
  const [serverFeaturesLoaded, setServerFeaturesLoaded] = useState(false)
  const [serverFeaturesNotice, setServerFeaturesNotice] = useState('')
  const [srvEnhanceSkill, setSrvEnhanceSkill] = useState('')
  const [srvEnhanceModel, setSrvEnhanceModel] = useState('')
  const [srvAndroidSkill, setSrvAndroidSkill] = useState('')
  const [srvAndroidModel, setSrvAndroidModel] = useState('')
  const [srvBuildNotesSkill, setSrvBuildNotesSkill] = useState('')
  const [srvBuildNotesModel, setSrvBuildNotesModel] = useState('')
  const [srvEditingVersion, setSrvEditingVersion] = useState(false)
  const [srvCustomVersion, setSrvCustomVersion] = useState('')
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
  const installedVersion = account?.bundle?.installedVersion || installed?.version
  const latestVersion = account?.bundle?.latestVersion
  const modelVersionLabel = formatCatalogVersion(account?.models?.version)
  const orchestratorVersionLabel = formatSemverVersion(account?.orchestrator?.version)
  const bundleVersionLabel = installedVersion ? formatSemverVersion(installedVersion) : 'Chưa cài'
  const versionSummaryLine = formatVersionSummaryLine({ modelVersion: account?.models?.version, orchestratorVersion: account?.orchestrator?.version, bundleVersion: installedVersion })
  const hasBundleUpdate = Boolean(latestVersion && latestVersion !== installedVersion)
  const statusPillLabel = hasBundleUpdate ? 'Có bản cập nhật mới' : account?.bundleAutoSyncError ? 'Cần kiểm tra đồng bộ' : account?.ready ? 'Đã mới nhất' : 'Chưa đồng bộ'
  const statusPillClass = hasBundleUpdate ? 'amekit-pill amekit-readiness--blocked' : !account?.bundleAutoSyncError && account?.ready ? 'amekit-pill amekit-readiness--ready' : 'amekit-pill'
  const refreshTime = (epoch: number) => new Date(epoch).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const selectableModels = account?.models?.active_models ?? [...new Set(Object.values(modelLevels).filter(Boolean))].map(id => ({ id, name: id }))
  const modelOptions = (selected: string) => <><option value="">Mặc định theo API (default · {defaultModelID || '—'})</option>{selected && !selectableModels.some(model => model.id === selected) && <option value={selected}>{selected} · Không còn hoạt động</option>}{selectableModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</>
  const resetFeatures = () => { setCommitEnhanceSkill(''); setCommitEnhanceModel(''); setAndroidTranslationSkill(''); setAndroidTranslationModel(''); setBuildNotesSkill(''); setBuildNotesModel('') }
  const autoVersion = suggestNextVersion([latest?.version, serverFeaturesRelease?.version, ...releases.map(release => release.version)])
  const effectiveVersion = editingVersion ? customVersion.trim() : autoVersion
  const srvPayload = Object.fromEntries(Object.entries(normalizeFeatures({ commitEnhanceSkill: srvEnhanceSkill, commitEnhanceModel: srvEnhanceModel, androidTranslationSkill: srvAndroidSkill, androidTranslationModel: srvAndroidModel, buildNotesSkill: srvBuildNotesSkill, buildNotesModel: srvBuildNotesModel })).filter(([, value]) => value))
  const srvDirty = JSON.stringify(normalizeFeatures(srvPayload)) !== JSON.stringify(normalizeFeatures(serverBaseFeatures))
  const srvEffectiveVersion = srvEditingVersion ? srvCustomVersion.trim() : autoVersion
  const featurePayload = { ...(commitEnhanceSkill ? { commitEnhanceSkill } : {}), ...(commitEnhanceModel ? { commitEnhanceModel } : {}), ...(androidTranslationSkill ? { androidTranslationSkill } : {}), ...(androidTranslationModel ? { androidTranslationModel } : {}), ...(buildNotesSkill ? { buildNotesSkill } : {}), ...(buildNotesModel ? { buildNotesModel } : {}) }
  const formatted = errorState ? formatAmeKitError(errorState.message) : undefined
  const renderInlineError = (targetScope: NonNullable<typeof errorState>['scope']) => errorState?.scope === targetScope && formatted ? <div className="amekit-alert amekit-alert--error" role="alert"><strong>{formatted.title}</strong>{formatted.detail && <p>{formatted.detail}</p>}{formatted.code && <small>Mã: {formatted.code}</small>}</div> : null
  const blockerInfo = account?.blocker ? formatAmeKitError(account.blocker) : undefined
  const bundleGeneration = useRef(0)
  const historyGeneration = useRef(0)
  const serverFeaturesGeneration = useRef(0)
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  // AmeKit's main-process service accepts only one operation at a time.
  const request = useCallback((operation: string, payload?: Record<string, string>) => {
    const next = pending.current.then(async () => {
      const value = await window.ame.account(operation, payload)
      if (['login', 'refresh', 'logout', 'sync', 'offline', 'uninstall', 'update-features'].includes(operation)) window.dispatchEvent(new Event('ame-account-changed'))
      return value
    })
    pending.current = next.catch(() => {})
    return next
  }, [])
  const applyServerSelections = useCallback((features: Features) => {
    const normalized = normalizeFeatures(features)
    setSrvEnhanceSkill(normalized.commitEnhanceSkill); setSrvEnhanceModel(normalized.commitEnhanceModel)
    setSrvAndroidSkill(normalized.androidTranslationSkill); setSrvAndroidModel(normalized.androidTranslationModel)
    setSrvBuildNotesSkill(normalized.buildNotesSkill); setSrvBuildNotesModel(normalized.buildNotesModel)
  }, [])
  const loadServerFeatures = useCallback(async () => {
    const generation = ++serverFeaturesGeneration.current
    const current = () => generation === serverFeaturesGeneration.current
    setServerFeaturesLoading(true); setServerFeaturesNotice(''); setErrorState(null)
    try {
      const data = object(await request('active-features'))
      if (!current()) return
      const release = data.release ? data.release as Release : null
      const features = (data.features ?? release?.manifest?.features ?? release?.features ?? {}) as Features
      setServerFeaturesRelease(release); setServerSkills(Array.isArray(data.skills) ? data.skills as string[] : [])
      setServerBaseFeatures(features); applyServerSelections(features); setNoRelease(false)
      if (release) { setLatest(release); setActiveReleaseId(releaseID(release)) }
      if (data.revision !== undefined) setRevision(String(data.revision))
    } catch (e) {
      if (!current()) return
      if (noActiveRelease(e)) {
        setNoRelease(true); setServerFeaturesRelease(null); setServerSkills([]); setServerBaseFeatures({}); applyServerSelections({})
      } else setErrorState({ scope: 'features', message: errorText(e) })
    } finally { if (current()) { setServerFeaturesLoading(false); setServerFeaturesLoaded(true) } }
  }, [request, applyServerSelections])
  useEffect(() => {
    if (tab !== 'admin' || adminTab !== 'features' || !isAdmin) return
    void loadServerFeatures()
    return () => { serverFeaturesGeneration.current++; setServerFeaturesLoading(false) }
  }, [tab, adminTab, isAdmin, loadServerFeatures])
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
    setHistoryLoading(true); setErrorState(null)
    void request('history').then(value => { if (current()) applyHistory(value) })
      .catch(e => { if (current()) setErrorState({ scope: 'history', message: errorText(e) }) })
      .finally(() => { if (current()) { setHistoryLoading(false); setHistoryLoaded(true) } })
    return () => { alive = false; if (generation === historyGeneration.current) { historyGeneration.current++; setHistoryLoading(false) } }
  }, [tab, isAdmin, request, applyHistory])
  useEffect(() => {
    if (tab !== 'bundle' || !account?.account) return
    let alive = true
    const generation = ++bundleGeneration.current
    const current = () => alive && generation === bundleGeneration.current
    setBundleLoading(true); setErrorState(null); setBundleNotice('')
    if (lastLegacyProject.current !== projectID) { setLegacyInfo(null); lastLegacyProject.current = projectID }
    const loadGlobal = async (silent = false) => {
      try { const value = await request('installed', {}); if (current()) setInstalled(value as Bundle) }
      catch (e) { if (current() && !silent) setErrorState({ scope: 'global', message: errorText(e) }) }
      if (!current()) return
      try {
        const data = object(await request('latest'))
        if (current()) { const release = object(data.release) as Release; setLatest(release); setNoRelease(false); setActiveReleaseId(releaseID(release)); setRevision(String(data.revision ?? '')) }
      } catch (e) {
        if (current()) {
          if (noActiveRelease(e)) { setLatest(null); setActiveReleaseId(''); setNoRelease(true) }
          else if (!silent) { setLatest(null); setErrorState({ scope: 'global', message: errorText(e) }) }
        }
      }
    }
    const onBundleUpdated = () => { void loadGlobal(true) }
    window.addEventListener('ame-bundle-updated', onBundleUpdated)
    void (async () => {
      await loadGlobal()
      if (projectID && current()) {
        try { const value = await request('legacy-installed', { project: projectID }); if (current()) setLegacyInfo((value as LegacyProjectBundle) ?? null) }
        catch { if (current()) setLegacyInfo(null) }
      }
    })().finally(() => { if (current()) { setBundleLoading(false); setBundleLoaded(true) } })
    return () => { alive = false; window.removeEventListener('ame-bundle-updated', onBundleUpdated); if (generation === bundleGeneration.current) { bundleGeneration.current++; setBundleLoading(false) } }
  }, [tab, !!account?.account, projectID, request])
  useEffect(() => {
    let alive = true
    void request('status').then(value => { if (alive) setAccount(value as AccountState) }).catch(e => { if (alive) setErrorState({ scope: 'global', message: errorText(e) }) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [request])
  useEffect(() => {
    setCommitEnhanceSkill(skill => importPreview?.skills.includes(skill) ? skill : '')
    setAndroidTranslationSkill(skill => importPreview?.skills.includes(skill) ? skill : '')
    setBuildNotesSkill(skill => importPreview?.skills.includes(skill) ? skill : '')
  }, [importPreview])
  const execute = async (operation: string, payload?: Record<string, string>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setBusyOp({ operation, path: payload?.path }); setErrorState(null)
    const importOperation = ['fix-import', 'fix-import-all', 'exclude-import-file', 'revert-import-fix', 'save-import-fix'].includes(operation)
    if (importOperation) setFixNotice('')
    if (operation === 'package') setPackaged(null)
    if (operation === 'update-features') setServerFeaturesNotice('')
    if (operation === 'refresh') setRefreshNotice('')
    try {
      const value = await request(operation, payload)
      if (['status', 'login', 'refresh', 'logout'].includes(operation)) {
        setAccount(value as AccountState); setPassword('')
        if (operation === 'refresh') {
          const refreshed = value as AccountState
          const version = refreshed?.bundle?.installedVersion || installed?.version
          const refreshedSummary = formatVersionSummaryLine({ modelVersion: refreshed?.models?.version, orchestratorVersion: refreshed?.orchestrator?.version, bundleVersion: version })
          setRefreshNotice(`Đã làm mới phiên lúc ${refreshTime(refreshed?.refreshedAt ?? Date.now())} · ${refreshedSummary}`)
        }
        if (operation === 'logout') {
          setRefreshNotice('')
          setBundleLoaded(false); setHistoryLoaded(false); setBundleLoading(false); setHistoryLoading(false)
          serverFeaturesGeneration.current++
          setServerFeaturesRelease(null); setServerSkills([]); setServerBaseFeatures({}); applyServerSelections({})
          setServerFeaturesNotice(''); setSrvEditingVersion(false); setSrvCustomVersion(''); setServerFeaturesLoaded(false); setServerFeaturesLoading(false)
          updateAdminTab('publish')
          setImportPreview(null); setPackaged(null); setPublishNotice(''); setLatest(null); setInstalled(null); setLegacyInfo(null); setBundleNotice(''); resetFeatures(); setAppliedFixes({}); setFixNotice('')
          setReleases([]); setCursor(''); setActiveReleaseId(''); setRevision(''); setNoRelease(false); setTab('account')
        }
      } else {
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
          setBuildNotesSkill(features.buildNotesSkill && preview?.skills.includes(features.buildNotesSkill) ? features.buildNotesSkill : '')
          setBuildNotesModel(features.buildNotesModel ?? '')
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
          if (operation === 'activate') { setPublishNotice(`Đã kích hoạt v${release.version || releaseID(release)} cho team.`) }
        }
        if (operation === 'release' || operation === 'publish') {
          const data = operation === 'release' ? value as { packaged?: Packaged; release?: Release; activated?: { release?: Release; revision?: number } | null; activationError?: string } : { release: value as Release }
          const published = data.release
          setPackaged(null); setEditingVersion(false); setCustomVersion('')
          if (published) {
            const id = releaseID(published)
            setPublishNotice(`Đã xuất bản v${published.version || id}.${data.activated ? ' Đã kích hoạt cho team.' : data.activationError ? ` Chưa kích hoạt: ${formatAmeKitError(data.activationError).title}. Mở lịch sử để thử Kích hoạt lại.` : ' Mở lịch sử để kích hoạt cho team khi sẵn sàng.'}`)
            setReleases(old => [published, ...old.filter(release => releaseID(release) !== id)])
            if (data.activated) {
              const active = data.activated.release ?? published
              setLatest(active); setActiveReleaseId(releaseID(active)); setNoRelease(false)
              setRevision(String(data.activated.revision ?? ''))
            }
            try {
              applyHistory(await request('history'))
              setReleases(old => old.some(release => releaseID(release) === id) ? old : [published, ...old])
            } catch (e) { setErrorState({ scope: 'history', message: errorText(e) }) }
          }
        }
        if (operation === 'update-features') {
          const data = value as { packaged?: Packaged; release?: Release; activated?: { release?: Release; revision?: number } | null; revision?: number; activationError?: string }
          const published = data.release
          setSrvEditingVersion(false); setSrvCustomVersion('')
          if (published) {
            const id = releaseID(published)
            setReleases(old => [published, ...old.filter(release => releaseID(release) !== id)])
            if (data.activated) {
              const features = published.manifest?.features ?? published.features ?? srvPayload
              setLatest(published); setActiveReleaseId(id); setNoRelease(false)
              setRevision(String(data.activated.revision ?? data.revision ?? ''))
              setServerFeaturesRelease(published); setServerBaseFeatures(features); applyServerSelections(features)
              setServerFeaturesNotice(`Đã đẩy cấu hình Skill & Model v${published.version || id} lên máy chủ và kích hoạt cho team.`)
            } else {
              setServerFeaturesNotice(`Đã xuất bản cấu hình v${published.version || id}. Chưa kích hoạt: ${data.activationError ? formatAmeKitError(data.activationError).title : 'Cần kích hoạt trong lịch sử'}. Tải lịch sử để thử kích hoạt lại.`)
            }
            try {
              applyHistory(await request('history'))
              setReleases(old => old.some(release => releaseID(release) === id) ? old : [published, ...old])
            } catch (e) { setErrorState({ scope: 'features', message: errorText(e) }) }
          }
        }
        if (operation === 'installed') setInstalled(value as Bundle)
        if (operation === 'sync' || operation === 'offline') setInstalled(value as Bundle)
        if (operation === 'sync') {
          setBundleNotice(`Đã đồng bộ AmeKit v${(value as Bundle)?.version || ''} toàn ứng dụng.`)
          try { setAccount(await request('status') as AccountState) } catch { /* A status refresh must not hide a successful sync. */ }
        }
        if (operation === 'uninstall') {
          setInstalled(await request('installed', {}) as Bundle)
          setBundleNotice('Đã gỡ bundle khỏi cấu hình toàn ứng dụng.')
        }
        if (operation === 'clean-legacy') {
          const cleaned = value as { removedFiles?: number }
          setLegacyInfo(null)
          setBundleNotice(`Đã dọn ${cleaned?.removedFiles ?? 0} tệp AmeKit cũ khỏi dự án.`)
          window.dispatchEvent(new Event('ame-legacy-cleaned'))
        }
        if (operation === 'history') applyHistory(value, !!payload?.cursor)
      }
    } catch (e) {
      if (operation === 'latest' && noActiveRelease(e)) { setLatest(null); setActiveReleaseId(''); setNoRelease(true) }
      else {
        const scope = operation === 'import' || importOperation ? 'source' : operation === 'update-features' ? 'features' : ['release', 'package', 'publish'].includes(operation) ? 'release' : ['history', 'activate'].includes(operation) ? 'history' : 'global'
        setErrorState({ scope, message: errorText(e) })
        if (operation === 'activate' && /\bACTIVATION_CONFLICT\b/.test(errorText(e))) {
          try { applyHistory(await request('history')) } catch { /* Keep the original actionable activation error. */ }
        }
      }
    } finally { busyRef.current = false; setBusy(false); setBusyOp(null) }
  }
  const renderIssues = () => <><div className="amekit-issue-tabs" role="tablist" aria-label="Phân loại vấn đề">{(Object.keys(issueLabels) as IssueSeverity[]).map(severity => <button key={severity} id={`amekit-issue-${severity}`} role="tab" aria-selected={issueTab === severity} aria-controls="amekit-issue-panel" onClick={() => setIssueTab(severity)}>{issueLabels[severity]} ({grouped[severity].length})</button>)}</div>
          <div id="amekit-issue-panel" className="amekit-issues" role="tabpanel" aria-labelledby={`amekit-issue-${issueTab}`} tabIndex={0}>{grouped[issueTab].length ? <ul>{grouped[issueTab].map((issue, index) => <li className="amekit-issue-row" key={index}><code>{issue.path || 'Bundle'}</code><span>{issue.reason}</span>{issueTab === 'error' && issue.path && <div className="amekit-issue-actions">{importPreview?.fixablePaths?.includes(issue.path) && <button type="button" disabled={busy} onClick={() => void execute('fix-import', { path: issue.path })}>{busyOp?.operation === 'fix-import' && busyOp.path === issue.path ? 'Đang sửa…' : 'Sửa bằng AI'}</button>}{canExcludeImportPath(issue.path) && <button type="button" disabled={busy} onClick={() => void execute('exclude-import-file', { path: issue.path })}>Bỏ tệp</button>}</div>}</li>)}</ul> : <p className="muted">Không có mục nào trong nhóm này.</p>}</div></>
  const content = <><div className="segmented account-tabs"><button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>Tài khoản</button><button className={tab === 'bundle' ? 'active' : ''} onClick={() => setTab('bundle')}>Bundle</button>{isAdmin && <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>Quản trị</button>}</div><div className="settings-content">
    {renderInlineError('global')}
    {loading ? <p>Đang đọc tài khoản…</p> : tab === 'account' ? <>{account?.account ? <>
      <section className="amekit-profile-card">
        <div className="profile-avatar" aria-hidden="true">{(account.account.name || account.account.username).trim().charAt(0).toLocaleUpperCase()}</div>
        <div className="amekit-profile-card__identity"><h3>{account.account.name || account.account.username}</h3><p>@{account.account.username}</p><p className="muted">{account.origin}</p></div>
        <span className="amekit-pill amekit-profile-card__role">{account.account.role || 'member'}</span>
      </section>
      <div className={`amekit-alert ${account.ready ? 'amekit-alert--success' : 'amekit-alert--warning'}`} role="status"><strong>{account.ready ? 'Tài khoản sẵn sàng' : blockerInfo?.title || (account.reconnecting ? 'Đang kết nối lại…' : 'Tài khoản chưa sẵn sàng')}</strong>{!account.ready && blockerInfo?.detail && <p>{blockerInfo.detail}</p>}</div>
      <div className="button-row"><button disabled={busy} onClick={() => void execute('refresh')}>Làm mới phiên</button><button disabled={busy} onClick={() => void execute('logout')}>Đăng xuất</button></div>
      {refreshNotice && <div className="amekit-alert amekit-alert--success" role="status" data-testid="amekit-refresh-notice">{refreshNotice}</div>}
      <section className="amekit-card" data-testid="amekit-account-versions">
        <div className="amekit-card-heading">
          <h4>Cấu hình AME</h4>
          <span className={statusPillClass} data-testid="amekit-version-status">{statusPillLabel}</span>
        </div>
        <p className="muted">Tự kiểm tra khi mở ứng dụng lần đầu trong ngày hoặc khi bấm <strong>Làm mới phiên</strong>. {account.refreshedAt !== undefined ? <>Đồng bộ gần nhất: <time dateTime={new Date(account.refreshedAt).toISOString()}>{refreshTime(account.refreshedAt)}</time>.</> : <>Chưa làm mới.</>}</p>
        <details className="amekit-details" data-testid="amekit-version-details">
          <summary>Chi tiết phiên bản ({versionSummaryLine})</summary>
          <dl>
            <div><dt>Model (Catalog API)</dt><dd>{modelVersionLabel}</dd></div>
            <div><dt>Agent điều phối</dt><dd>{orchestratorVersionLabel}</dd></div>
            <div><dt>Bundle đã cài</dt><dd>{bundleVersionLabel}</dd></div>
            {hasBundleUpdate && <div><dt>Bundle mới nhất</dt><dd>{formatSemverVersion(latestVersion)}</dd></div>}
            <div><dt>Làm mới gần nhất</dt><dd>{account.refreshedAt !== undefined ? <time dateTime={new Date(account.refreshedAt).toISOString()}>{refreshTime(account.refreshedAt)}</time> : 'Chưa làm mới'}</dd></div>
          </dl>
        </details>
      </section>
      {account.bundleAutoSyncError && <div className="amekit-alert amekit-alert--warning" role="status"><strong>Tự đồng bộ nền chưa thể áp dụng bundle: {formatAmeKitError(account.bundleAutoSyncError).title}</strong><p>{formatAmeKitError(account.bundleAutoSyncError).detail} Mở Bundle để thử Đồng bộ / Cập nhật ngay.</p></div>}
      {(account.models?.model_levels || account.models?.default_model) && <section className="amekit-card amekit-model-levels"><h4>Phân cấp Model từ API</h4><dl>{Object.entries(modelLevels).map(([level, id]) => <div key={level}><dt><code>{level}</code></dt><dd><code>{id || '—'}</code></dd></div>)}</dl></section>}
      {activeModels.length > 0 && <details className="amekit-details amekit-active-models" data-testid="amekit-active-models"><summary>Tất cả Model đang hoạt động từ API ({activeModels.length})</summary><ul>{activeModels.map(model => <li key={model.id}><strong>{model.name}</strong> <code>{model.id}</code>{model.vision && <span className="amekit-pill">Vision</span>}{model.reasoning && <span className="amekit-pill">Reasoning</span>}</li>)}</ul></details>}
    </> : <form onSubmit={e => { e.preventDefault(); void execute('login', { ...(server.trim() ? { server: server.trim() } : {}), username, password }) }}>
      {account?.reconnecting ? <div className="amekit-alert amekit-alert--warning" role="status"><strong>{blockerInfo?.title || 'Đang kết nối lại tài khoản đã lưu…'}</strong>{blockerInfo?.detail && <p>{blockerInfo.detail}</p>}<div className="button-row"><button type="button" disabled={busy} onClick={() => void execute('refresh')}>Kết nối lại</button><button type="button" disabled={busy} onClick={() => void execute('logout')}>Đăng xuất tài khoản đã lưu</button></div></div> : blockerInfo && <div className="amekit-alert amekit-alert--warning" role="status"><strong>{blockerInfo.title}</strong>{blockerInfo.detail && <p>{blockerInfo.detail}</p>}</div>}
      <p className="muted">Thông tin đăng nhập được bảo vệ bởi kho khóa bảo mật của hệ thống.</p>
      <label>Máy chủ (tùy chọn)<input type="url" placeholder="https://amecode.ameno.tech" value={server} onChange={e => setServer(e.target.value)} /></label>
      <label>Tên đăng nhập<input required autoComplete="username" placeholder="Nhập tên đăng nhập" value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>Mật khẩu<input required type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <div className="button-row"><button className="primary" disabled={busy}>Đăng nhập</button>{account?.blocker && <button type="button" disabled={busy} onClick={() => void execute('status')}>Kiểm tra lại</button>}</div>
    </form>}</> : tab === 'bundle' ? <>
      <section className="amekit-card" data-testid="amekit-global-bundle">
        <h3>Bundle toàn ứng dụng</h3>
        <p className="muted">Agents &amp; Skills dùng chung toàn ứng dụng (tự kiểm tra lần mở đầu tiên trong ngày hoặc khi bấm làm mới/đồng bộ, không thêm tệp vào Git dự án).</p>
        {installed ? <>
          <div className="amekit-badges"><strong>Đang dùng: v{installed.version || installed.releaseId}</strong><span className="amekit-pill">{installed.compatibilityMode || 'native'}</span><span className={`amekit-pill ${latest && installed.releaseId === releaseID(latest) ? 'amekit-readiness--ready' : ''}`}>{latest && installed.releaseId === releaseID(latest) ? 'Đã mới nhất' : latest ? `Có bản mới v${latest.version || releaseID(latest)}` : 'Đã cài cục bộ'}</span><EnhanceSummary features={installed.features} /></div>
          <p className="amekit-stats">{installed.verification === 'runtime-ready' ? 'Sẵn sàng OpenCode' : 'Đã xác minh chữ ký/byte'} · {installed.agents?.length ?? 0} agents · {installed.skills?.length ?? 0} skills · {installed.fileCount ?? 0} tệp</p>
          <details className="amekit-details"><summary>Danh sách Agents ({installed.agents?.length ?? 0}) &amp; Skills ({installed.skills?.length ?? 0})</summary><BundleInventory agents={installed.agents || []} skills={installed.skills || []} /></details>
        </> : bundleLoading && !bundleLoaded ? <p className="muted" role="status">Đang kiểm tra trạng thái bundle…</p> : <p className="muted">Ứng dụng chưa đồng bộ bundle nào (sẽ tự tải khi có bản kích hoạt).</p>}
        {latest && (!installed || installed.releaseId !== releaseID(latest) || latest.version !== installed.version || JSON.stringify(latest.manifest?.features ?? latest.features ?? {}) !== JSON.stringify(installed.features ?? {})) ? <div className="amekit-server-release"><strong>Trên máy chủ: v{latest.version || releaseID(latest)}</strong> <span className="amekit-pill">{latest.manifest?.compatibility?.mode || 'native'}</span><ReleaseSummary release={latest} /></div> : noRelease && <p className="muted">Máy chủ chưa có bản phát hành nào được kích hoạt.</p>}
        {account?.bundleAutoSyncError && <div className="amekit-alert amekit-alert--warning" role="status"><strong>Tự đồng bộ nền chưa thể áp dụng bundle: {formatAmeKitError(account.bundleAutoSyncError).title}</strong><p>{formatAmeKitError(account.bundleAutoSyncError).detail} Chọn Đồng bộ / Cập nhật ngay để thử lại thủ công.</p></div>}
        <div className="button-row"><button className="primary" disabled={busy || noRelease} onClick={() => void execute('sync', {})}>{busyOp?.operation === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ / Cập nhật ngay'}</button>{installed && <button disabled={busy} onClick={() => void execute('uninstall', {})}>Gỡ bundle</button>}</div>
      </section>
      {bundleNotice && <div className="amekit-alert amekit-alert--success" role="status">{bundleNotice}</div>}
      {legacyInfo && projectID && <section className="amekit-card amekit-legacy-card" data-testid="amekit-legacy-cleanup">
        <h3>Phát hiện bundle cũ trong dự án {legacyInfo.projectName || 'hiện tại'}</h3>
        <p className="muted">Dự án đang chứa {legacyInfo.fileCount > 0 ? `${legacyInfo.fileCount} tệp ` : ''}cấu hình cũ trong <code>.opencode/</code> / <code>.amekit/</code> từ phiên bản trước{legacyInfo.modified ? ' (có thay đổi cục bộ hoặc trạng thái cần kiểm tra)' : ''}. Dọn dẹp sẽ chỉ xóa tệp do AmeKit tạo và giữ nguyên toàn bộ tệp cá nhân.</p>
        {legacyInfo.error && <p className="muted">{formatAmeKitError(legacyInfo.error).title}</p>}
        <div className="button-row"><button type="button" disabled={busy} onClick={() => void execute('clean-legacy', { project: projectID })}>{busyOp?.operation === 'clean-legacy' ? 'Đang dọn…' : 'Dọn bundle cũ khỏi dự án'}</button></div>
      </section>}
    </> : isAdmin ? <>
      <div className="segmented amekit-admin-tabs" role="tablist" aria-label="Quản trị AmeKit"><button role="tab" aria-selected={adminTab === 'publish'} className={adminTab === 'publish' ? 'active' : ''} onClick={() => setAdminTab('publish')}>Phát hành mới</button><button role="tab" aria-selected={adminTab === 'features'} className={adminTab === 'features' ? 'active' : ''} onClick={() => setAdminTab('features')}>Cấu hình Model</button><button role="tab" aria-selected={adminTab === 'history'} className={adminTab === 'history' ? 'active' : ''} onClick={() => setAdminTab('history')}>{`Lịch sử (${releases.length})`}</button></div>
      {publishNotice && <div className={`amekit-alert ${publishNotice.includes('Chưa kích hoạt:') ? 'amekit-alert--warning' : 'amekit-alert--success'}`} role="status">{publishNotice}{adminTab !== 'history' && <button type="button" onClick={() => setAdminTab('history')}>Xem lịch sử</button>}</div>}
      {adminTab === 'publish' ? <>
      {renderInlineError('history')}
      <section className="amekit-card" data-testid="amekit-source-card"><h3>1. Thư mục nguồn (agents/ &amp; skills/)</h3>
        <div className="amekit-source-bar">
        <label>Chế độ tương thích<select aria-label="Chế độ tương thích" disabled={busy} value={mode} onChange={e => setMode(e.target.value)}><option value="raw-adapt">Raw + Chuẩn hóa agent Claude -&gt; OpenCode (khuyên dùng cho gói Claude)</option><option value="native">Native (Chuẩn OpenCode 2.3.2 nghiêm ngặt)</option><option value="raw">Raw (Giữ nguyên byte gốc)</option></select></label>
        <button data-testid="amekit-import-btn" disabled={busy} onClick={() => void execute('import', { compatibilityMode: mode === 'raw-adapt' ? 'raw' : mode, ...(mode === 'raw-adapt' ? { adaptClaudeAgents: 'true' } : {}) })}>{busyOp?.operation === 'import' ? 'Đang quét thư mục…' : importPreview ? 'Đổi thư mục' : 'Chọn thư mục & nhập'}</button>
        </div>
        {renderInlineError('source')}
        {importPreview && <div className="amekit-inspector">
          <div className="amekit-badges"><strong className="amekit-pill">{importPreview.folderName}</strong><span className="amekit-pill">{importPreview.adaptClaudeAgents ? 'raw-adapt' : importPreview.compatibilityMode}</span><span className={`amekit-pill ${grouped.error.length ? 'amekit-readiness--blocked' : 'amekit-readiness--ready'}`}>{grouped.error.length ? `Bị chặn · ${grouped.error.length} lỗi` : 'Sẵn sàng phát hành'}</span></div>
          <p className="amekit-stats">{importPreview.agents.length} agents · {importPreview.skills.length} skills · {importPreview.files.length} tệp · {formatBundleSize(importPreview.files.reduce((sum, file) => sum + file.size, 0))} gốc</p>
          {importPreview.files.length > 9000 && <p className="amekit-alert amekit-alert--warning">Gần giới hạn 10.000 tệp. Hãy loại bớt tệp không cần thiết trước khi phát hành.</p>}
          {grouped.suggestClaudeAdapt && mode === 'native' && <div className="amekit-alert amekit-alert--warning"><strong>Phát hiện frontmatter agent Claude không tương thích Native.</strong><p>Các trường tools, model: inherit, color cần được chuẩn hóa cho OpenCode. Chuyển chế độ rồi chọn nhập lại thư mục để kiểm tra.</p><button disabled={busy} onClick={() => setMode('raw-adapt')}>Chuyển sang "Raw + Chuẩn hóa agent Claude"</button></div>}
          {mode !== (importPreview.adaptClaudeAgents ? 'raw-adapt' : importPreview.compatibilityMode) && <p className="muted">Chế độ mới chỉ áp dụng lần nhập tiếp theo. Chọn thư mục &amp; nhập lại để cập nhật kết quả.</p>}
          <details className="amekit-details"><summary>Danh sách Agents ({importPreview.agents.length}) &amp; Skills ({importPreview.skills.length})</summary><BundleInventory agents={importPreview.agents} skills={importPreview.skills} /></details>
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
          {grouped.error.length > 0 ? renderIssues() : <details className="amekit-details"><summary>Chi tiết kiểm tra ({grouped.warning.length} cảnh báo · {grouped.change.length} chuyển đổi · {grouped.excluded.length} loại trừ)</summary>{renderIssues()}</details>}
          {Object.keys(appliedFixes).length > 0 && <div className="amekit-fix-list"><p className="muted">Các bản sửa đang áp dụng tạm để đóng gói (chưa ghi đè thư mục gốc nếu chưa bấm Lưu).</p>{Object.values(appliedFixes).map(fix => <article className="amekit-fix-card" key={fix.path}>
            <div className="amekit-badges"><code>{fix.path}</code><span className="amekit-pill">{fix.kind === 'ai' ? `Đã sửa bởi AI · default (${fix.model})` : 'Đã bỏ khỏi gói'}</span></div>
            <p>{fix.summary}</p>
            {fix.diff && <details><summary>Xem thay đổi (diff)</summary><pre className="amekit-fix-diff">{fix.diff}</pre></details>}
            <div className="amekit-issue-actions">{fix.kind === 'ai' && <button type="button" disabled={busy || fix.saved} onClick={() => void execute('save-import-fix', { path: fix.path })}>{fix.saved ? 'Đã lưu vào đĩa' : 'Lưu về thư mục gốc'}</button>}<button type="button" disabled={busy} title="Khôi phục gói tạm; không thay đổi tệp đã lưu trên đĩa" onClick={() => void execute('revert-import-fix', { path: fix.path })}>Hoàn tác</button></div>
          </article>)}</div>}
        </div>}
      </section>
      {importPreview && <section className="amekit-card" data-testid="amekit-features-card"><h3>2. Tính năng tích hợp (tùy chọn)</h3><div className="amekit-feature-grid">
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
            <fieldset className="amekit-feature-config"><legend>Mô tả bản build (QC Build Notes)</legend>
              <label>Skill cho Mô tả bản build<select aria-label="Skill cho Mô tả bản build" disabled={busy} value={buildNotesSkill} onChange={e => { setBuildNotesSkill(e.target.value); setPackaged(null) }}><option value="">Mặc định (Mô tả bản build QC)</option>{importPreview.skills.map(skill => <option key={skill} value={skill}>/{skill}</option>)}</select></label>
              <label>Model cho Mô tả bản build<select aria-label="Model cho Mô tả bản build" disabled={busy} value={buildNotesModel} onChange={e => { setBuildNotesModel(e.target.value); setPackaged(null) }}>{modelOptions(buildNotesModel)}</select></label>
              <p className="muted">Thành viên tự động dùng skill (hoặc mẫu QC mặc định) và model đã cấu hình khi tạo mô tả bản build trong Git Workspace.</p>
            </fieldset>
      </div></section>}
      <section className="amekit-card" data-testid="amekit-release-card"><h3>{importPreview ? '3.' : '2.'} Phát hành cho team</h3>
        <div className="amekit-version-bar">{editingVersion ? <><label>Phiên bản<input aria-label="Phiên bản" value={customVersion} placeholder={autoVersion} disabled={busy} onChange={e => setCustomVersion(e.target.value)} /></label><button type="button" disabled={busy} onClick={() => { setEditingVersion(false); setCustomVersion('') }}>{`Dùng tự động (v${autoVersion})`}</button></> : <><span>Phiên bản tiếp theo</span><strong className="amekit-version-badge">v{autoVersion}</strong><span className="amekit-pill">Tự tăng</span><button type="button" disabled={busy} onClick={() => { setCustomVersion(autoVersion); setEditingVersion(true) }}>Sửa phiên bản</button></>}</div>
        <label className="checkbox"><input type="checkbox" checked={activateNow} disabled={busy} onChange={e => setActivateNow(e.target.checked)} />Kích hoạt ngay cho team sau khi xuất bản</label>
        {importPreview && grouped.error.length > 0 && <p className="amekit-alert amekit-alert--warning">Phát hành bị khóa. Hãy sửa hoặc bỏ các tệp lỗi trong thư mục nguồn; kết quả được kiểm tra lại ngay.</p>}
        {renderInlineError('release')}
        {['release', 'package', 'publish'].includes(busyOp?.operation ?? '') && <div className="amekit-busy-inline" role="status"><span className="amekit-spinner" aria-hidden="true" /><span>{busyOp?.operation === 'package' ? 'Đang đóng gói…' : 'Đang phát hành…'}</span></div>}
        <div className="amekit-release-actions">
          <button type="button" className="primary" disabled={busy || !effectiveVersion || !importPreview || grouped.error.length > 0} onClick={() => void execute('release', { version: effectiveVersion, activate: activateNow ? 'true' : 'false', ...featurePayload })}>{busyOp?.operation === 'release' ? 'Đang phát hành…' : activateNow ? `Phát hành & kích hoạt v${effectiveVersion || autoVersion}` : `Xuất bản nháp v${effectiveVersion || autoVersion}`}</button>
          <button type="button" disabled={busy || !effectiveVersion || !importPreview || grouped.error.length > 0} onClick={() => void execute('package', { version: effectiveVersion, ...featurePayload })}>{busyOp?.operation === 'package' ? 'Đang đóng gói…' : 'Chỉ đóng gói thử'}</button>
        </div>
        {packaged && <div className="amekit-package-summary">Đã đóng gói v{packaged.summary.version} · {formatBundleSize(packaged.size)} · {packaged.entries} mục · SHA-256 <code>{packaged.sha256}</code> <EnhanceSummary features={packaged.summary.features} /><button type="button" disabled={busy} onClick={() => void execute('publish')}>Xuất bản gói đã nén</button></div>}
      </section>
      </> : adminTab === 'features' ? <section className="amekit-card" data-testid="amekit-server-features-card">
        <div className="amekit-server-features-head"><h3>Cấu hình Skill &amp; Model trên máy chủ</h3><button type="button" disabled={busy || serverFeaturesLoading} onClick={() => void loadServerFeatures()}>Làm mới từ máy chủ</button></div>
        <p className="muted">Thay đổi trực tiếp skill hoặc model cố định và đẩy lên máy chủ mà không cần chọn hay import lại thư mục agents/skills.</p>
        {serverFeaturesLoading && !serverFeaturesLoaded ? <p className="muted" role="status">Đang tải cấu hình từ máy chủ…</p> : noRelease || !serverFeaturesRelease ? <div className="amekit-alert amekit-alert--warning" role="alert"><strong>Máy chủ chưa có bản phát hành nào được kích hoạt.</strong><p>Xuất bản và kích hoạt bundle đầu tiên trước khi cấu hình Skill &amp; Model.</p><button type="button" onClick={() => setAdminTab('publish')}>Đi tới Phát hành mới</button></div> : <>
          <div className="amekit-badges"><strong>Đang áp dụng: v{serverFeaturesRelease.version} · {serverFeaturesRelease.manifest?.agents ?? 0} agents · {serverSkills.length} skills</strong><EnhanceSummary features={serverBaseFeatures} /></div>
          {serverFeaturesLoading && <p className="muted" role="status">Đang tải cấu hình từ máy chủ…</p>}
          <div className="amekit-feature-grid">
            <fieldset className="amekit-feature-config"><legend>Enhance (Commit message)</legend>
              <label>Skill máy chủ cho Enhance<select aria-label="Skill máy chủ cho Enhance" disabled={busy || serverFeaturesLoading} value={srvEnhanceSkill} onChange={e => setSrvEnhanceSkill(e.target.value)}><option value="">Mặc định (Conventional Commits)</option>{serverSkills.map(skill => <option key={skill} value={skill}>/{skill}</option>)}</select></label>
              <label>Model máy chủ cho Enhance<select aria-label="Model máy chủ cho Enhance" disabled={busy || serverFeaturesLoading} value={srvEnhanceModel} onChange={e => setSrvEnhanceModel(e.target.value)}>{modelOptions(srvEnhanceModel)}</select></label>
            </fieldset>
            <fieldset className="amekit-feature-config"><legend>Dịch Android (Strings translation)</legend>
              <label>Skill máy chủ cho Dịch Android<select aria-label="Skill máy chủ cho Dịch Android" disabled={busy || serverFeaturesLoading} value={srvAndroidSkill} onChange={e => setSrvAndroidSkill(e.target.value)}><option value="">Không bật</option>{serverSkills.map(skill => <option key={skill} value={skill}>/{skill}</option>)}</select></label>
              <label>Model máy chủ cho Dịch Android<select aria-label="Model máy chủ cho Dịch Android" disabled={busy || serverFeaturesLoading || !srvAndroidSkill} value={srvAndroidModel} onChange={e => setSrvAndroidModel(e.target.value)}>{modelOptions(srvAndroidModel)}</select></label>
            </fieldset>
            <fieldset className="amekit-feature-config"><legend>Mô tả bản build (QC Build Notes)</legend>
              <label>Skill máy chủ cho Mô tả bản build<select aria-label="Skill máy chủ cho Mô tả bản build" disabled={busy || serverFeaturesLoading} value={srvBuildNotesSkill} onChange={e => setSrvBuildNotesSkill(e.target.value)}><option value="">Mặc định (Mô tả bản build QC)</option>{serverSkills.map(skill => <option key={skill} value={skill}>/{skill}</option>)}</select></label>
              <label>Model máy chủ cho Mô tả bản build<select aria-label="Model máy chủ cho Mô tả bản build" disabled={busy || serverFeaturesLoading} value={srvBuildNotesModel} onChange={e => setSrvBuildNotesModel(e.target.value)}>{modelOptions(srvBuildNotesModel)}</select></label>
            </fieldset>
          </div>
          <div className="amekit-version-bar">{srvEditingVersion ? <><label>Phiên bản cấu hình máy chủ<input aria-label="Phiên bản cấu hình máy chủ" value={srvCustomVersion} placeholder={autoVersion} disabled={busy || serverFeaturesLoading} onChange={e => setSrvCustomVersion(e.target.value)} /></label><button type="button" disabled={busy || serverFeaturesLoading} onClick={() => { setSrvEditingVersion(false); setSrvCustomVersion('') }}>{`Dùng tự động (v${autoVersion})`}</button></> : <><span>Phiên bản tiếp theo</span><strong className="amekit-version-badge">v{autoVersion}</strong><span className="amekit-pill">Tự tăng</span><button type="button" disabled={busy || serverFeaturesLoading} onClick={() => { setSrvCustomVersion(autoVersion); setSrvEditingVersion(true) }}>Sửa phiên bản</button></>}</div>
          <button type="button" className="primary" data-testid="amekit-save-server-features-btn" disabled={busy || serverFeaturesLoading || !srvEffectiveVersion || !srvDirty || !serverFeaturesRelease} onClick={() => void execute('update-features', { version: srvEffectiveVersion, activate: 'true', ...srvPayload })}>{busyOp?.operation === 'update-features' ? 'Đang đẩy lên máy chủ…' : `Lưu & đẩy lên máy chủ v${srvEffectiveVersion}`}</button>
        </>}
        {renderInlineError('features')}
        {busyOp?.operation === 'update-features' && <p className="muted" role="status">Đang đóng gói &amp; đẩy cấu hình lên máy chủ…</p>}
        {serverFeaturesNotice && <div className={`amekit-alert ${serverFeaturesNotice.includes('Chưa kích hoạt:') ? 'amekit-alert--warning' : 'amekit-alert--success'}`} role="status">{serverFeaturesNotice}{serverFeaturesNotice.includes('Chưa kích hoạt:') && <button type="button" disabled={busy} onClick={() => { setAdminTab('history'); void execute('history') }}>Tải lịch sử</button>}</div>}
      </section> : <section className="amekit-card">
        {renderInlineError('history')}
        <div className="amekit-card-heading"><p className="muted">{activeReleaseId ? 'Có bản đang kích hoạt' : 'Chưa kích hoạt bản nào'}</p><div className="button-row"><button disabled={busy} onClick={() => void execute('history')}>Làm mới</button>{cursor && <button disabled={busy} onClick={() => void execute('history', { cursor })}>Tải thêm</button>}</div></div>
        {!releases.length && (historyLoading && !historyLoaded ? <p className="muted" role="status">Đang tải lịch sử phát hành…</p> : <p className="muted">Chưa có bản phát hành nào trên máy chủ.</p>)}
        <div className="amekit-releases">{releases.map(release => { const id = releaseID(release); return <article className="amekit-release" key={id}><div className="amekit-card-heading"><div className="amekit-badges"><strong>v{release.version || id}</strong>{activeReleaseId === id && <span className="amekit-pill amekit-readiness--ready">Đang kích hoạt</span>}<span className="amekit-pill">{release.manifest?.compatibility?.mode || 'native'}</span></div>{activeReleaseId !== id && <button disabled={busy || !revision} onClick={() => void execute('activate', { id, revision })}>Kích hoạt</button>}</div><ReleaseSummary release={release} /></article> })}</div>
      </section>}
    </> : <p>Chỉ quản trị viên có thể quản lý release.</p>}
    {busy && !['import', 'fix-import', 'fix-import-all', 'release', 'package', 'publish', 'update-features'].includes(busyOp?.operation ?? '') && <p role="status">Đang xử lý…</p>}
  </div></>
  const core = <section className="amekit-core" aria-label="AmeKit">{content}</section>
  return embedded ? core : <Modal title="AmeKit" close={close}>{core}</Modal>
}
