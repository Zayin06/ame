import { useState } from 'react'
import type { Connection, PetHostState } from '../../../../../packages/protocol/src/index'
import { PetSettings } from './PetSettings'
import { formatShortcut } from '../platform'
import { errorText, Modal } from './Primitives'
import type { Preferences } from '../state'
import { Account } from './Account'
import { Pairing } from './Pairing'
import { Icon } from './Icon'

export function Settings({ preferences, setLayout, theme, setTheme, connection, setConnection, close, initialSection = 'appearance', isMac = false, pet, sprite, selectedModel, onPet }: { initialSection?: 'appearance' | 'amekit' | 'pairing' | 'pet'; preferences: Preferences; setLayout: (patch: Partial<Pick<Preferences, 'layoutMode' | 'tint' | 'chatWidth' | 'timelineDetail'>>) => void; theme: 'dark' | 'light'; setTheme: (theme: 'dark' | 'light') => void; connection: Connection; setConnection: (connection: Connection) => void; close: () => void; isMac?: boolean; pet: PetHostState | null; sprite: string; selectedModel?: string; onPet: (state: PetHostState) => void }) {
  const [section, setSection] = useState<'appearance' | 'amekit' | 'pairing' | 'pet'>(initialSection)
  const [busy, setBusy] = useState(false)
  const [restartError, setRestartError] = useState('')
  const restart = async () => { setBusy(true); setRestartError(''); try { const result = await window.ame.startBackend(); setConnection(result); if (result.error) setRestartError(result.error) } catch (e) { setRestartError(errorText(e)) } finally { setBusy(false) } }
  const status = `${connection.connected ? `Đã kết nối ${connection.version || ''}`.trim() : 'Chưa kết nối'}${connection.url ? ` · ${connection.url.replace(/^https?:\/\//, '')}` : ''}`
  return <Modal title="Cài đặt" close={close}>
    <nav className="settings-navigation" aria-label="Cài đặt">
      <button type="button" className={section === 'appearance' ? 'active' : ''} onClick={() => setSection('appearance')}>Giao diện & hệ thống</button>
      <button type="button" className={section === 'amekit' ? 'active' : ''} onClick={() => setSection('amekit')}>AmeKit</button>
      <button type="button" className={section === 'pairing' ? 'active' : ''} onClick={() => setSection('pairing')}>Pairing</button>
      <button type="button" className={section === 'pet' ? 'active' : ''} onClick={() => setSection('pet')}>Desktop Pet</button>
    </nav>
    {section === 'pet' ? <PetSettings petState={pet} spriteUrl={sprite} selectedModel={selectedModel} onConfigure={async input => onPet(await window.ame.petConfigure(input))} onSpeech={async input => onPet(await window.ame.petSpeech(input))} onGenerateDialogue={async model => onPet(await window.ame.petGenerateDialogue(model))} onTestSpeech={async () => onPet(await window.ame.petTestSpeech())} /> : section === 'amekit' ? <Account key={preferences.project} embedded projectID={preferences.project} selectedModel={selectedModel} close={close} /> : section === 'pairing' ? <Pairing /> : <div className="settings-content settings-content--general">
      <section>
        <h3 className="settings-section-title">Giao diện</h3>
        <div className="settings-group">
          <div className="setting-row" data-setting="theme">
            <div className="setting-row__info"><div className="setting-row__title">Chủ đề</div></div>
            <select className="settings-select" aria-label="Chủ đề" value={theme} onChange={e => setTheme(e.target.value as 'dark' | 'light')}><option value="dark">Tối</option><option value="light">Sáng</option></select>
          </div>
          <div className="setting-row" data-setting="timeline-detail">
            <div className="setting-row__info"><div className="setting-row__title">Tiến trình chat</div><div className="setting-row__desc">Tự thu gọn công cụ khi agent trả lời xong</div></div>
            <div className="segmented">{(['compact', 'detailed', 'everything'] as const).map(value => <button type="button" key={value} aria-pressed={preferences.timelineDetail === value} className={`segmented__btn ${preferences.timelineDetail === value ? 'is-active' : ''}`} onClick={() => setLayout({ timelineDetail: value })}>{value === 'compact' ? 'Gọn' : value === 'detailed' ? 'Chi tiết' : 'Đầy đủ'}</button>)}</div>
          </div>
          <div className="setting-row" data-setting="chat-width">
            <div className="setting-row__info"><div className="setting-row__title">Độ rộng chat</div></div>
            <div className="segmented">{([640, 760, 960] as const).map((value, i) => <button type="button" key={value} aria-pressed={preferences.chatWidth === value} className={`segmented__btn ${preferences.chatWidth === value ? 'is-active' : ''}`} onClick={() => setLayout({ chatWidth: value })}>{['Compact', 'Default', 'Wide'][i]}</button>)}</div>
          </div>
          <div className="setting-row" data-setting="workspace-tint">
            <div className="setting-row__info"><div className="setting-row__title">Tông màu</div></div>
            <div className="segmented">{(['default', 'nord', 'everforest'] as const).map(value => <button type="button" key={value} aria-pressed={preferences.tint === value} className={`segmented__btn ${preferences.tint === value ? 'is-active' : ''}`} onClick={() => setLayout({ tint: value })}>{value}</button>)}</div>
          </div>
          <div className="setting-row" data-setting="layout-mode">
            <div className="setting-row__info"><div className="setting-row__title">Bố cục</div><div className="setting-row__desc">Hiển thị công cụ lập trình hoặc tối giản</div></div>
            <div className="segmented">{(['swe', 'knowledge'] as const).map(value => <button type="button" key={value} aria-pressed={preferences.layoutMode === value} className={`segmented__btn ${preferences.layoutMode === value ? 'is-active' : ''}`} onClick={() => setLayout({ layoutMode: value })}>{value === 'swe' ? 'Software Eng' : 'Knowledge Work'}</button>)}</div>
          </div>
        </div>
      </section>
      <section>
        <h3 className="settings-section-title">Hệ thống</h3>
        <div className="settings-group">
          <div className="setting-row setting-row--backend">
            <div className="setting-row__info"><div className="setting-row__title"><span className={`connection-dot ${connection.connected ? 'connected' : ''}`} aria-hidden="true" /> OpenCode tích hợp</div><div className="setting-row__desc">{status}</div></div>
            <button type="button" className="settings-action-btn" disabled={busy} title="Dùng / thử lại backend tích hợp" aria-label="Dùng hoặc thử lại backend tích hợp" onClick={() => void restart()}>{busy ? 'Đang kết nối…' : 'Thử lại'}</button>
          </div>
        </div>
        {(connection.error || restartError) && <p className="inline-error settings-inline-error" role="alert">{restartError || connection.error}</p>}
      </section>
      <details className="settings-disclosure" data-testid="settings-shortcuts">
        <summary className="settings-disclosure__summary" tabIndex={0}><Icon name="chevron" /><span>Phím tắt</span><span className="settings-disclosure__meta">10 phím tắt</span></summary>
        <dl className="shortcut-grid">
          <dt><kbd>{formatShortcut('Ctrl+S', isMac)}</kbd></dt><dd>Lưu tệp</dd>
          <dt><kbd>{formatShortcut('Ctrl+B', isMac)}</kbd></dt><dd>Dự án và hội thoại</dd>
          <dt><kbd>{formatShortcut('Ctrl+Alt+B', isMac)}</kbd></dt><dd>Bảng bên</dd>
          <dt><kbd>{formatShortcut('Ctrl+Shift+E', isMac)}</kbd></dt><dd>Trình duyệt dự án</dd>
          <dt><kbd>{formatShortcut('Ctrl+Shift+F', isMac)}</kbd></dt><dd>Tìm trong dự án</dd>
          <dt><kbd>{formatShortcut('Ctrl+J', isMac)}</kbd> hoặc <kbd>{formatShortcut('Ctrl+`', isMac)}</kbd></dt><dd>Bảng dưới</dd>
          <dt><kbd>{formatShortcut('Ctrl+Shift+`', isMac)}</kbd></dt><dd>Terminal mới</dd>
          <dt><kbd>{formatShortcut('Ctrl+Enter', isMac)}</kbd></dt><dd>Commit các tệp đã stage</dd>
          <dt><kbd>{formatShortcut('Ctrl+K', isMac)}</kbd></dt><dd>Bảng lệnh</dd>
          <dt><kbd>{formatShortcut('Ctrl+,', isMac)}</kbd></dt><dd>Cài đặt</dd>
        </dl>
      </details>
    </div>}
  </Modal>
}
