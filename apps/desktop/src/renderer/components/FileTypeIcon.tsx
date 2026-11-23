import { fileTypeMeta } from '../scm-display'
import { Icon } from './Icon'

export function FileTypeIcon({ path }: { path: string }) {
  const meta = fileTypeMeta(path)
  return <span className={`file-type-icon file-type-icon--${meta.kind}`} aria-hidden="true">
    {meta.kind === 'md' ? <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3h14v10H1V3Zm1 1v8h12V4H2Zm1 1h1.5L6 7l1.5-2H9v6H7.5V7.5L6 9.5 4.5 7.5V11H3V5Zm8 0h1v3h1.5L11.5 11 9.5 8H11V5Z" /></svg>
      : meta.kind === 'image' ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1"><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><circle cx="5" cy="6" r="1" fill="currentColor" stroke="none" /><path d="m2 12 4-4 3 3 2-2 3 3" /></svg>
        : meta.glyph ? <span className="file-type-icon__glyph">{meta.glyph}</span> : <Icon name="file" />}
  </span>
}
