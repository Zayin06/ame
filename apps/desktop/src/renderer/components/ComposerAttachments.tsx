import { Icon } from './Icon'
import type { ChatAttachment } from '../../../../../packages/ide-core/src/dropped-attachments'
import type { ComposerAttachment } from '../composer-mentions'

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`
}

export function ComposerAttachmentStrip({ attachments, onRemove }: { attachments: readonly ComposerAttachment[]; onRemove: (id: string) => void }) {
  if (!attachments.length) return null
  return <div className="composer-attachments" aria-label="Tệp đính kèm">{attachments.map(item => {
    if ('path' in item) return <span className="attachment-chip" key={item.id}><Icon name="file" /><span className="truncate">{item.path}</span><button type="button" aria-label={`Bỏ đính kèm ${item.path}`} onClick={() => onRemove(item.id)}>×</button></span>
    const image = item.mime.startsWith('image/')
    return <span className={`attachment-chip${image ? ' attachment-chip--media' : ''}`} key={item.id}>
      {image ? <img className="attachment-thumb" src={item.dataUrl} alt={item.name} /> : <Icon name="file" />}
      <span className="truncate">{item.name}</span><small className="muted">({formatBytes(item.size)})</small>
      <button type="button" aria-label={`Bỏ đính kèm ${item.name}`} onClick={() => onRemove(item.id)}>×</button>
    </span>
  })}</div>
}

export function ComposerDropOverlay({ active }: { active: boolean }) {
  return active ? <div className="composer-drop-overlay" role="status" aria-live="polite"><span>Thả tệp hoặc ảnh vào đây để đính kèm</span></div> : null
}

export function MessageAttachmentList({ attachments }: { attachments?: readonly ChatAttachment[] }) {
  if (!attachments?.length) return null
  return <div className="msg-user-attachments">{attachments.map((att, index) => att.mime.startsWith('image/') && att.dataUrl
    ? <div key={index}><img className="msg-user-thumb" src={att.dataUrl} alt={att.name} /><span>{att.name}</span></div>
    : <span className="attachment-chip" key={index}><Icon name="file" /><span className="truncate">{att.name}</span>{att.size ? <small className="muted">({formatBytes(att.size)})</small> : null}</span>
  )}</div>
}
