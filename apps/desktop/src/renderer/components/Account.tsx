import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, Modal } from './Primitives'

type AccountState = { origin?: string; account?: { name: string; username: string; role?: string }; ready?: boolean; reconnecting?: boolean; blocker?: string } | null
type Release = { releaseId?: string; id?: string; version?: string; channel?: string; manifest?: { compatibility?: { mode?: string } } }
type Bundle = { version?: string; releaseId?: string; verification?: unknown; compatibilityWarnings?: unknown; compatibilityMode?: string } | null
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function noActiveRelease(error: unknown) { return /\bNO_ACTIVE_RELEASE\b/.test(errorText(error)) }
function OperationSummary({ value }: { value: unknown }) {
  const data = object(value), summary = object(data.summary), manifest = object(data.manifest)
  const info = Object.keys(summary).length ? summary : Object.keys(manifest).length ? manifest : data
  const count = (key: string) => Array.isArray(info[key]) ? info[key].length : typeof info[key] === 'number' ? info[key] : undefined
  const issues = [data.issues, data.compatibilityWarnings].flatMap(rows => Array.isArray(rows) ? rows.map(object) : [])
  const agents = count('agents'), skills = count('skills'), files = count('files') ?? count('fileCount')
  if (agents === undefined && skills === undefined && files === undefined && data.size === undefined && data.verification === undefined && data.changed === undefined && !issues.length) return null
  return <div className="operation-summary" role="status"><p>{[
    agents !== undefined ? `${agents} agents` : '', skills !== undefined ? `${skills} skills` : '',
    files !== undefined ? `${files} tệp` : '', typeof data.size === 'number' ? `${(data.size / 1024 / 1024).toFixed(2)} MiB` : '',
    typeof data.compatibilityMode === 'string' ? data.compatibilityMode : '', typeof data.verification === 'string' ? data.verification : '',
    typeof data.changed === 'boolean' ? (data.changed ? 'Đã cập nhật' : 'Không thay đổi') : '',
  ].filter(Boolean).join(' · ')}</p><p>{([['error', 'lỗi'], ['warning', 'cảnh báo'], ['change', 'chuyển đổi'], ['excluded', 'loại trừ']] as const).map(([severity, label]) => `${issues.filter(issue => issue.severity === severity).length} ${label}`).join(' · ')}</p>{issues.length > 0 && <ul>{issues.slice(0, 4).map((issue, index) => <li key={index}>{String(issue.path || 'Bundle')}: {String(issue.reason ?? issue)}</li>)}</ul>}</div>
}
export function Account({ projectID, close, embedded = false }: { projectID?: string; close: () => void; embedded?: boolean }) {
  const [account, setAccount] = useState<AccountState>(null)
  const [tab, setTab] = useState('account')
  const [busy, setBusy] = useState(false)
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
  const bundleGeneration = useRef(0)
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  // AmeKit's main-process service accepts only one operation at a time.
  const request = useCallback((operation: string, payload?: Record<string, string>) => {
    const next = pending.current.then(() => window.ame.account(operation, payload))
    pending.current = next.catch(() => {})
    return next
  }, [])
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
        if (current()) { setLatest(object(data.release) as Release); setRevision(String(data.revision ?? '')) }
      } catch (e) {
        if (current()) {
          setLatest(null)
          if (noActiveRelease(e)) setNoRelease(true)
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
  const execute = async (operation: string, payload?: Record<string, string>) => {
    setBusy(true); setError(''); setResult(undefined)
    try {
      const value = await request(operation, payload)
      if (['status', 'login', 'refresh', 'logout'].includes(operation)) { setAccount(value as AccountState); setPassword(''); window.dispatchEvent(new Event('ame-account-changed')) }
      else {
        setResult(value)
        if (operation === 'latest' || operation === 'activate') { const data = object(value); setLatest(object(data.release) as Release); setNoRelease(false); setRevision(String(data.revision ?? '')) }
        if (operation === 'publish') {
          const published = value as Release, id = published.releaseId || published.id || ''
          setActivation(id)
          setReleases(old => [published, ...old.filter(release => (release.releaseId || release.id) !== id)])
          const data = object(await request('history'))
          const rows = Array.isArray(data.releases) ? data.releases as Release[] : []
          setReleases(rows.some(release => (release.releaseId || release.id) === id) ? rows : [published, ...rows])
          setCursor(typeof data.nextCursor === 'string' ? data.nextCursor : '')
          const active = object(data.active)
          if (active.revision !== undefined) setRevision(String(active.revision))
        }
        if (operation === 'installed') setInstalled(value as Bundle)
        if (operation === 'sync' || operation === 'offline' || operation === 'uninstall') {
          window.dispatchEvent(new Event('ame-account-changed'))
          setInstalled(await request('installed', { project: projectID! }) as Bundle)
        }
        if (operation === 'history') { const data = object(value); const rows = Array.isArray(data.releases) ? data.releases as Release[] : []; setReleases(old => payload?.cursor ? [...old, ...rows] : rows); setCursor(typeof data.nextCursor === 'string' ? data.nextCursor : ''); const active = object(data.active); if (active.revision !== undefined) setRevision(String(active.revision)) }
      }
    } catch (e) {
      if (operation === 'latest' && noActiveRelease(e)) { setLatest(null); setNoRelease(true) }
      else setError(errorText(e))
    } finally { setBusy(false) }
  }
  const isAdmin = account?.account?.role === 'admin' || account?.account?.role === 'owner'
  const content = <><div className="segmented account-tabs"><button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>Tài khoản</button><button className={tab === 'bundle' ? 'active' : ''} onClick={() => setTab('bundle')}>Bundle</button>{isAdmin && <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>Quản trị</button>}</div><div className="settings-content">
    {loading ? <p>Đang đọc tài khoản…</p> : tab === 'account' ? <>{account?.account ? <><h3>{account.account.name}</h3><p>@{account.account.username} · {account.account.role || 'member'}</p><p className="muted">{account.origin}</p><div className={account.ready ? 'success' : 'warning'}>{account.ready ? 'Tài khoản sẵn sàng' : account.blocker || (account.reconnecting ? 'Đang kết nối lại…' : 'Tài khoản chưa sẵn sàng')}</div><div className="button-row"><button disabled={busy} onClick={() => void execute('status')}>Trạng thái</button><button disabled={busy} onClick={() => void execute('refresh')}>Làm mới</button><button disabled={busy} onClick={() => void execute('logout')}>Đăng xuất</button></div></> : <form onSubmit={e => { e.preventDefault(); void execute('login', { ...(server.trim() ? { server: server.trim() } : {}), username, password }) }}>{account?.reconnecting && <div className="warning"><p>{account.blocker || 'Đang kết nối lại tài khoản đã lưu…'}</p><div className="button-row"><button type="button" disabled={busy} onClick={() => void execute('refresh')}>Kết nối lại / làm mới</button><button type="button" disabled={busy} onClick={() => void execute('logout')}>Đăng xuất tài khoản đã lưu</button></div></div>}{!account?.reconnecting && account?.blocker && <p className="warning">{account.blocker}</p>}<p className="muted">Đăng nhập AmeCode. Thông tin đăng nhập không được lưu trong renderer.</p><label>Máy chủ (tùy chọn)<input type="url" value={server} onChange={e => setServer(e.target.value)} /></label><label>Tên đăng nhập<input required autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></label><label>Mật khẩu<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><div className="button-row"><button className="primary" disabled={busy}>Đăng nhập</button><button type="button" disabled={busy} onClick={() => void execute('status')}>Trạng thái</button><button type="button" disabled={busy} onClick={() => void execute('refresh')}>Làm mới</button></div></form>}</> : tab === 'bundle' ? <><h3>Bundle dự án</h3><p className="muted">{projectID ? 'Các thao tác áp dụng cho dự án đang chọn.' : 'Chọn dự án trước khi cài bundle.'}</p><div className="button-row"><button disabled={busy} onClick={() => void execute('latest')}>Bản mới nhất</button><button disabled={busy || !projectID} onClick={() => void execute('installed', { project: projectID! })}>Đã cài</button></div>{latest && <p>Mới nhất: {latest.version || latest.releaseId || latest.id} · {latest.channel} · {latest.manifest?.compatibility?.mode || 'native'}</p>}{noRelease && <p className="muted">Máy chủ chưa có bản phát hành nào được kích hoạt.</p>}{installed ? <p>Đã cài: {installed.version || installed.releaseId} · {installed.compatibilityMode}</p> : <p className="muted">Chưa có thông tin bundle đã cài.</p>}{latest?.manifest?.compatibility?.mode === 'raw' && !raw && <p className="muted">Bản phát hành mới nhất dùng chế độ Raw — bật tùy chọn bên dưới trước khi đồng bộ.</p>}<label className="checkbox"><input type="checkbox" checked={raw} onChange={e => setRaw(e.target.checked)} />Cho phép raw compatibility khi đồng bộ</label><div className="button-row"><button className="primary" disabled={busy || !projectID} onClick={() => void execute('sync', { project: projectID!, ...(raw ? { allowRaw: 'true' } : {}) })}>Đồng bộ mới nhất</button><button disabled={busy || !projectID} onClick={() => void execute('offline', { project: projectID! })}>Kiểm tra tệp đã cài (offline)</button><button disabled={busy || !projectID} onClick={() => void execute('uninstall', { project: projectID! })}>Gỡ bundle</button></div><p className="muted">Các thay đổi tệp được xác nhận bằng hộp thoại native.</p></> : isAdmin ? <><h3>Nhập & đóng gói</h3><label>Chế độ tương thích<select value={mode} onChange={e => setMode(e.target.value)}><option value="native">Native (Chuẩn OpenCode 2.3.2)</option><option value="raw-adapt">Raw + Chuẩn hóa agent Claude -&gt; OpenCode</option><option value="raw">Raw (Giữ nguyên byte gốc)</option></select></label><button disabled={busy} onClick={() => void execute('import', { compatibilityMode: mode === 'raw-adapt' ? 'raw' : mode, ...(mode === 'raw-adapt' ? { adaptClaudeAgents: 'true' } : {}) })}>Chọn thư mục & nhập</button><form onSubmit={e => { e.preventDefault(); void execute('package', { version: version.trim() }) }}><label>Phiên bản<input value={version} required placeholder="1.0.0" onChange={e => setVersion(e.target.value)} /></label><div className="button-row"><button disabled={busy || !version.trim()}>Đóng gói</button><button type="button" disabled={busy} onClick={() => void execute('publish')}>Xuất bản gói đã chuẩn bị</button></div></form><h3>Lịch sử & kích hoạt</h3><div className="button-row"><button disabled={busy} onClick={() => void execute('history')}>Lấy lịch sử</button>{cursor && <button disabled={busy} onClick={() => void execute('history', { cursor })}>Trang tiếp</button>}</div><label>Release<select value={activation} onChange={e => setActivation(e.target.value)}><option value="">Chọn release</option>{releases.map(release => { const id = release.releaseId || release.id || ''; return <option key={id} value={id}>{release.version || id} · {release.channel}</option> })}</select></label><label>Revision hiện tại<input value={revision} onChange={e => setRevision(e.target.value)} /></label><button disabled={busy || !activation || !revision} onClick={() => void execute('activate', { id: activation, revision })}>Kích hoạt release</button></> : <p>Chỉ quản trị viên có thể quản lý release.</p>}
    {busy && <p role="status">Đang xử lý…</p>}{error && <p className="inline-error" role="alert">{error}</p>}{result !== undefined && <><OperationSummary value={result} /><details key={JSON.stringify(result)} open={!(Array.isArray(object(result).files) && (object(result).files as unknown[]).length > 20)} className="operation-result"><summary>Kết quả máy chủ</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></>}
  </div></>
  return embedded ? <section className="amekit-core" aria-label="AmeKit">{content}</section> : <Modal title="AmeKit" close={close}>{content}</Modal>
}
