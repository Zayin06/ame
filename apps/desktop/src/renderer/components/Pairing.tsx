import { useEffect, useRef, useState } from 'react'
import type { PairingCode, PairingSettings } from '../../../../../packages/protocol/src/index'
import { renderSVG } from '../qr'
import { errorText } from './Primitives'

export function Pairing() {
  const [settings, setSettings] = useState<PairingSettings>()
  const [code, setCode] = useState<PairingCode>()
  const [dialog, setDialog] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const generation = useRef(0)
  const mounted = useRef(true)
  const closeButton = useRef<HTMLButtonElement>(null)
  const pairButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    mounted.current = true
    const poll = () => void window.ame.pairingStatus().then(value => { if (mounted.current) setSettings(value) }, e => { if (mounted.current) setError(errorText(e)) })
    poll()
    const timer = setInterval(() => { setNow(Date.now()); poll() }, 1000)
    return () => { mounted.current = false; generation.current++; clearInterval(timer) }
  }, [])
  const close = () => { generation.current++; setDialog(false); setCode(undefined); setCopied(false); setBusy(false); pairButton.current?.focus() }
  useEffect(() => { if (dialog) closeButton.current?.focus() }, [dialog])
  const issue = async () => {
    if (!settings) return
    const attempt = ++generation.current
    setDialog(true); setBusy(true); setError(''); setCopied(false); setCode(undefined)
    try {
      if (!settings.enabled) {
        const value = await window.ame.pairingConfigure({ enabled: true, keepScreenActive: settings.keepScreenActive })
        if (mounted.current) setSettings(value)
      }
      if (!mounted.current || generation.current !== attempt) return
      const value = await window.ame.pairingCode()
      if (mounted.current && generation.current === attempt) { setCode(value); setNow(Date.now()) }
    } catch (e) { if (mounted.current && generation.current === attempt) setError(errorText(e)) }
    finally { if (mounted.current && generation.current === attempt) setBusy(false) }
  }
  useEffect(() => { if (dialog && code && now >= code.expiresAt && !busy) void issue() }, [now, code, busy, dialog])
  const save = async (enabled: boolean, keepScreenActive = settings?.keepScreenActive ?? false) => {
    if (!settings) return
    setBusy(true); setError('')
    try { const value = await window.ame.pairingConfigure({ enabled, keepScreenActive }); if (mounted.current) setSettings(value) }
    catch (e) { if (mounted.current) setError(errorText(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const revokeDevice = async (deviceID: string) => {
    setBusy(true); setError('')
    try { const value = await window.ame.pairingRevokeDevice(deviceID); if (mounted.current) setSettings(value) }
    catch (e) { const text = errorText(e); if (mounted.current && text !== 'Action canceled' && text !== 'USER_CANCELED') setError(text) }
    finally { if (mounted.current) setBusy(false) }
  }
  const revokeAll = async () => {
    setBusy(true); setError('')
    try { const value = await window.ame.pairingRevokeAll(); if (mounted.current) setSettings(value) }
    catch (e) { const text = errorText(e); if (mounted.current && text !== 'Action canceled' && text !== 'USER_CANCELED') setError(text) }
    finally { if (mounted.current) setBusy(false) }
  }
  const devices = settings?.devices ?? []
  const remaining = Math.max(0, Math.ceil(((code?.expiresAt ?? now) - now) / 1000))
  return <section className="settings-content pairing-settings" aria-label="Pairing">
    <h3>Pair a device</h3>
    <p className="muted">Connect OpenCode on another device to this computer.</p>
    <button ref={pairButton} className="primary" disabled={busy || !settings} onClick={() => void issue()}>Pair device</button>
    {settings && <div className="pairing-options">
      <div className="setting-row"><div><div className="setting-row__title">Remote access</div><p className="setting-row__desc">Connect from anywhere through an end-to-end encrypted tunnel.</p></div><button className="pairing-switch" role="switch" aria-label="Remote access" aria-checked={settings.enabled} disabled={busy} onClick={() => void save(!settings.enabled)}><span /></button></div>
      <div className="setting-row"><div><div className="setting-row__title">Keep screen active</div><p className="setting-row__desc">Keep this computer awake while OpenCode is running.</p></div><button className="pairing-switch" role="switch" aria-label="Keep screen active" aria-checked={settings.keepScreenActive} disabled={busy} onClick={() => void save(settings.enabled, !settings.keepScreenActive)}><span /></button></div>
    </div>}
    {settings?.connecting && !dialog && <p role="status">Đang tạo kết nối bảo mật… Lần đầu có thể mất vài phút.</p>}
    {!dialog && (error || settings?.error) && <p className="inline-error" role="alert">{error || settings?.error}</p>}
    <section className="pairing-devices" aria-label="Thiết bị đã ghép nối">
      <div className="pairing-devices__header"><h4>Thiết bị đã ghép nối ({devices.length})</h4>{devices.length > 0 && <button type="button" className="pairing-revoke-btn" disabled={busy} onClick={() => void revokeAll()}>Ngắt tất cả</button>}</div>
      {devices.length === 0 ? <p className="muted">Chưa có thiết bị nào được ghép nối. Sau khi quét mã QR, thiết bị sẽ tự kết nối lại mỗi khi Ame IDE đang mở.</p> : <ul className="pairing-device-list">
        {devices.map(device => <li key={device.id} className="pairing-device-row">
          <div className="pairing-device-info"><div className="pairing-device-name">{device.label}</div><div className="pairing-device-meta">Ghép nối {new Date(device.createdAt).toLocaleString('vi-VN')} · Hoạt động {new Date(device.lastUsedAt).toLocaleString('vi-VN')}</div></div>
          <button type="button" className="pairing-revoke-btn" disabled={busy} onClick={() => void revokeDevice(device.id)}>Ngắt kết nối</button>
        </li>)}
      </ul>}
    </section>
    <p className="muted pairing-warning">Chỉ chia sẻ mã với thiết bị của bạn: thiết bị ghép nối có toàn quyền OpenCode và được lưu kết nối vĩnh viễn cho tới khi bạn bấm Ngắt kết nối. Tắt Remote access sẽ tạm chặn mọi truy cập từ xa mà không xóa danh sách thiết bị.</p>
    {dialog && <div className="pairing-dialog-shade" onMouseDown={e => { if (e.target === e.currentTarget) close() }} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      if (e.key === 'Tab') {
        e.stopPropagation()
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const first = buttons[0], last = buttons.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}><div className="pairing-dialog" role="dialog" aria-modal="true" aria-label="Pair a device">
      <header><h2>Pair a device</h2><button ref={closeButton} aria-label="Close pairing" onClick={close}>×</button></header>
      <p className="muted">Scan this QR code with OpenCode on your other device.</p>
      <div className="pairing-code">
        {code && remaining > 0 ? <><img alt="Quét bằng OpenCode Android để ghép nối" width="260" height="260" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(code.qr, { border: 4 }))}`} /><p role="status">Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</p></> : <p role="status">{busy ? 'Đang chuẩn bị kết nối bảo mật… Lần đầu có thể mất vài phút.' : 'Chưa có mã ghép nối.'}</p>}
      </div>
      {(error || settings?.error) && <p className="inline-error" role="alert">{error || settings?.error}</p>}
      <div className="button-row"><button disabled={busy} onClick={() => void issue()}>Refresh code</button><button disabled={!code || remaining <= 0 || busy} onClick={() => code && void navigator.clipboard.writeText(code.url).then(() => { if (mounted.current) setCopied(true) }, e => setError(errorText(e)))}>{copied ? 'Copied' : 'Copy link'}</button></div>
    </div></div>}
  </section>
}
