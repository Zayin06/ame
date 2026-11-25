import { z } from 'zod'

export type SessionFormValue = string | number | boolean | string[]
export type SessionFormAnswer = Record<string, SessionFormValue>
export type SessionFormOption = { value: string; label: string; description?: string }
export type SessionFormWhen = { key: string; op: 'eq' | 'neq'; value: string | number | boolean }
export type SessionFormField = {
  key: string; title?: string; description?: string; required?: boolean; hidden?: boolean; when?: SessionFormWhen[]
} & (
  | { type: 'string'; options?: SessionFormOption[]; custom?: boolean; allowCustom?: boolean; default?: string; placeholder?: string; minLength?: number; maxLength?: number; pattern?: string; format?: 'email' | 'uri' | 'date' | 'date-time' }
  | { type: 'multiselect'; options: SessionFormOption[]; custom?: boolean; default?: string[]; minItems?: number; maxItems?: number }
  | { type: 'number' | 'integer'; default?: number | string; minimum?: number | string; maximum?: number | string }
  | { type: 'boolean'; default?: boolean }
  | { type: 'external'; url: string }
)
export type SessionForm = { id: string; sessionID: string; title: string; fields: SessionFormField[] }

export const sessionFormKeySchema = z.string().min(1).max(200).refine(value =>
  !!value.trim() && !value.includes('\0') && !['__proto__', 'prototype', 'constructor'].includes(value))
const value = z.union([z.string().max(20000).refine(value => !value.includes('\0')), z.number().finite(), z.boolean(), z.array(z.string().max(20000).refine(value => !value.includes('\0'))).max(100)])
export const sessionFormAnswerSchema = z.custom<SessionFormAnswer>(input => !!input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => sessionFormKeySchema.safeParse(key).success))
  .pipe(z.record(sessionFormKeySchema, value)).refine(answer =>
  Object.keys(answer).length <= 100 && JSON.stringify(answer).length <= 200000)
