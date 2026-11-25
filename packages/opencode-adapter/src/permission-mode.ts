import type { PermissionRule, SessionInfo } from '@opencode/client'
import { permissionModeSchema, type PermissionMode } from '../../protocol/src/permission-mode'

// OpenCode V2: write/patch check `edit`, and the shell tool checks `shell`.
// https://opencode.ai/docs/permissions — last matching rule wins.
const readingActions = ['read', 'glob', 'grep', 'webfetch', 'websearch']
export function permissionRules(mode: PermissionMode): PermissionRule[] {
  switch (permissionModeSchema.parse(mode)) {
    case 'default': return []
    case 'full': return [{ action: '*', resource: '*', effect: 'allow' }]
    case 'ask': return [
      { action: '*', resource: '*', effect: 'ask' },
      ...readingActions.map(action => ({ action, resource: '*', effect: 'allow' as const })),
      ...['edit', 'shell', 'external_directory'].map(action => ({ action, resource: '*', effect: 'ask' as const })),
    ]
    case 'readonly': return [
      { action: '*', resource: '*', effect: 'deny' },
      ...readingActions.map(action => ({ action, resource: '*', effect: 'allow' as const })),
    ]
  }
}

// Unknown/custom rules must never be presented as a trusted permissive preset.
export function permissionModeFromSession(session: Pick<SessionInfo, 'permissions'>): PermissionMode {
  const rules = session.permissions ?? []
  for (const mode of permissionModeSchema.options) {
    const expected = permissionRules(mode)
    if (rules.length === expected.length && rules.every((rule, i) => rule.action === expected[i].action && rule.resource === expected[i].resource && rule.effect === expected[i].effect)) return mode
  }
  return 'default'
}
