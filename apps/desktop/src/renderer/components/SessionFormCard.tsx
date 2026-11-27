import { useRef, useState } from 'react'
import type { SessionForm, SessionFormAnswer, SessionFormField } from '../../../../../packages/protocol/src/index'
import { normalizeFormNumber, sessionFormAnswerSchema } from '../../../../../packages/protocol/src/session-form'
import { errorText } from './Primitives'

export function visibleFormField(field: SessionFormField, answer: SessionFormAnswer): boolean {
  return !field.hidden && (field.when ?? []).every(condition => condition.op === 'eq' ? answer[condition.key] === condition.value : answer[condition.key] !== condition.value)
}

export function initialFormAnswer(form: SessionForm): SessionFormAnswer {
  return Object.fromEntries(form.fields.flatMap(field => {
    if (!('default' in field)) return []
    const value = field.type === 'number' || field.type === 'integer' ? normalizeFormNumber(field.default, field.type) : field.default
    return value === undefined ? [] : [[field.key, value]]
  })) as SessionFormAnswer
}

export function validateFormAnswer(form: SessionForm, answer: SessionFormAnswer): SessionFormAnswer {
  const result: SessionFormAnswer = Object.create(null)
  for (const field of form.fields) {
    if (!visibleFormField(field, answer) || field.type === 'external') continue
    const raw = answer[field.key]
    const value = field.type === 'number' || field.type === 'integer' ? normalizeFormNumber(raw, field.type) : raw
    const missing = value === undefined || typeof value === 'string' && !value.trim() || Array.isArray(value) && !value.length
    const fail = () => { throw new Error(`Vui lòng kiểm tra câu trả lời: ${field.title || field.key}`) }
    if (value === undefined && raw !== undefined && !(typeof raw === 'string' && !raw.trim())) fail()
    if (missing) { if (field.required) fail(); else continue }
    if (field.type === 'string') {
      if (typeof value !== 'string') fail()
      const text = value as string
      if (text.length < (field.minLength ?? 0) || text.length > (field.maxLength ?? 20000)) fail()
      if (field.pattern) {
        // Treat server-supplied patterns as untrusted: reject quantified groups,
        // backreferences/lookarounds and cap input before running the JS engine.
        if (field.pattern.length > 256 || text.length > 1024) fail()
        // A deliberately small regex subset: no groups/alternation/backreferences,
        // and only one repetition site (including bounded repetitions).
        const tokens = field.pattern.match(/\\.|\[(?:\\.|[^\]\\])*\]|[^]/g) ?? []
        let repetitions = 0
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index]
          if (token.startsWith('[')) continue
          if (token.startsWith('\\')) { if (/^\\[1-9k]$/.test(token)) fail(); continue }
          if ('()|'.includes(token)) fail()
          if ('*+?{'.includes(token) && ++repetitions > 1) fail()
        }
        if (/\{/.test(field.pattern)) fail()
        try { if (!new RegExp(field.pattern).test(text)) fail() } catch { fail() }
      }
      if (field.options?.length && field.required && !field.custom && !field.allowCustom && !field.options.some(option => option.value === value)) fail()
    } else if (field.type === 'multiselect') {
      if (!Array.isArray(value) || value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 100)) fail()
      if (Array.isArray(value) && !field.custom && value.some(entry => !field.options.some(option => option.value === entry))) fail()
    } else if (field.type === 'boolean') { if (typeof value !== 'boolean') fail() }
    else if (typeof value !== 'number' || !Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value) || value < Number(field.minimum ?? -Infinity) || value > Number(field.maximum ?? Infinity)) fail()
    result[field.key] = value!
  }
  return sessionFormAnswerSchema.parse(result)
}

export function SessionFormCard({ projectID, form, disabled = false, onResolved }: { projectID: string; form: SessionForm; disabled?: boolean; onResolved: (formID: string) => void }) {
  const [answer, setAnswer] = useState<SessionFormAnswer>(() => initialFormAnswer(form))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const inFlight = useRef(false)
  const set = (key: string, value: SessionFormAnswer[string] | undefined) => setAnswer(current => {
    const next = { ...current }; if (value === undefined) delete next[key]; else Object.defineProperty(next, key, { value, enumerable: true, configurable: true, writable: true }); return next
  })
  const submit = async (cancel = false) => {
    if (disabled || inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      if (cancel) await window.ame.cancelForm(projectID, form.sessionID, form.id)
      else await window.ame.replyForm(projectID, form.sessionID, form.id, validateFormAnswer(form, answer))
      onResolved(form.id)
    } catch (e) { setError(errorText(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <form className="session-form-card" aria-label={form.title} onSubmit={event => { event.preventDefault(); void submit() }}>
    <header><h3>{form.title}</h3><span>Đang chờ câu trả lời của bạn</span></header>
    <fieldset disabled={disabled || busy}>
      {form.fields.filter(field => visibleFormField(field, answer)).map(field => {
        const value = answer[field.key]
        const label = field.title || field.key
        const options = 'options' in field ? field.options : undefined
        return <div className="session-form-card__field" key={field.key} role="group" aria-label={label}>
          <label htmlFor={`${form.id}-${field.key}`}>{label}{field.required && <span aria-label="bắt buộc"> *</span>}</label>
          {field.description && <p>{field.description}</p>}
          {options && <div className="session-form-card__options">{options.map(option => <label key={option.value} title={option.description}>
            <input type={field.type === 'multiselect' ? 'checkbox' : 'radio'} name={`${form.id}-${field.key}`} checked={field.type === 'multiselect' ? Array.isArray(value) && value.includes(option.value) : value === option.value} onChange={() => set(field.key, field.type === 'multiselect' ? Array.isArray(value) && value.includes(option.value) ? value.filter(entry => entry !== option.value) : [...(Array.isArray(value) ? value : []), option.value] : option.value)} />
            <span>{option.label}{option.description && <small>{option.description}</small>}</span>
          </label>)}</div>}
          {field.type === 'string' && (!options?.length || !field.required || field.custom || field.allowCustom) && <input id={`${form.id}-${field.key}`} aria-label={options?.length ? `${label} — câu trả lời khác` : label} type={field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'} placeholder={field.placeholder || (options?.length ? 'Hoặc nhập câu trả lời khác…' : '')} value={typeof value === 'string' ? value : ''} onChange={event => set(field.key, event.target.value)} />}
          {field.type === 'multiselect' && field.custom && <input id={`${form.id}-${field.key}`} aria-label={`${label} — thêm lựa chọn`} placeholder="Nhập lựa chọn khác, nhấn Enter" onKeyDown={event => { if (event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return; if (event.key === 'Enter') { event.preventDefault(); const text = event.currentTarget.value.trim(); if (text) set(field.key, [...new Set([...(Array.isArray(value) ? value : []), text])]); event.currentTarget.value = '' } }} />}
          {field.type === 'multiselect' && Array.isArray(value) && value.filter(entry => !field.options.some(option => option.value === entry)).map(entry => <button type="button" key={entry} onClick={() => set(field.key, value.filter(item => item !== entry))}>{entry} ×</button>)}
          {field.type === 'boolean' && <input id={`${form.id}-${field.key}`} aria-label={label} type="checkbox" checked={value === true} onChange={event => set(field.key, event.target.checked)} />}
          {(field.type === 'number' || field.type === 'integer') && <input id={`${form.id}-${field.key}`} aria-label={label} type="number" step={field.type === 'integer' ? 1 : 'any'} min={typeof field.minimum === 'number' ? field.minimum : undefined} max={typeof field.maximum === 'number' ? field.maximum : undefined} value={typeof value === 'number' ? value : ''} onChange={event => set(field.key, event.target.value === '' ? undefined : event.target.valueAsNumber)} />}
          {field.type === 'external' && (/^https?:\/\//i.test(field.url) ? <div className="button-row">
            <button type="button" onClick={async () => { try { await window.ame.openExternal(field.url) } catch (e) { setError(errorText(e)) } }}>Mở trang trả lời</button>
            <button type="button" onClick={async () => { setCopied(''); try { await navigator.clipboard.writeText(field.url); setCopied(field.key) } catch (e) { setError(errorText(e)) } }}>Sao chép liên kết</button>
            {copied === field.key && <span role="status">Đã sao chép</span>}
          </div> : <p>Không thể mở liên kết này. Bạn có thể hủy câu hỏi.</p>)}
        </div>
      })}
    </fieldset>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="button-row"><button type="submit" disabled={disabled || busy}>{busy ? 'Đang gửi…' : 'Gửi câu trả lời'}</button><button type="button" disabled={disabled || busy} onClick={() => void submit(true)}>Bỏ qua / Hủy câu hỏi</button></div>
  </form>
}
