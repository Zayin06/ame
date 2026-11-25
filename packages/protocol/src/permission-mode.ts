import { z } from 'zod'

export const permissionModeSchema = z.enum(['default', 'ask', 'readonly', 'full'])
export type PermissionMode = z.infer<typeof permissionModeSchema>
