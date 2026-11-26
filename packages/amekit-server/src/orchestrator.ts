import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { OrchestratorConfig } from "../../amekit/src/orchestrator"
import { EMPTY_MANAGED_CATALOG, normalizeManagedCatalog, type ManagedCatalog } from "./managed-catalog"

type PermissionRule = NonNullable<ReturnType<AgentEditor['get']>>['permissions'][number]

export function orchestratorPermissions(managedCatalog: ManagedCatalog = EMPTY_MANAGED_CATALOG): PermissionRule[] {
  const normalized = normalizeManagedCatalog(managedCatalog)
  return [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'read', resource: '*.env', effect: 'ask' },
    { action: 'read', resource: '*.env.*', effect: 'ask' },
    { action: 'read', resource: '*.env.example', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'edit', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'webfetch', resource: '*', effect: 'allow' },
    { action: 'websearch', resource: '*', effect: 'allow' },
    { action: 'question', resource: '*', effect: 'allow' },
    { action: 'todowrite', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'ask' },
    { action: 'subagent', resource: '*', effect: 'deny' },
    ...normalized.agents.map(id => ({ action: 'subagent', resource: id, effect: 'allow' as const })),
    { action: 'skill', resource: '*', effect: 'deny' },
    ...normalized.skills.map(id => ({ action: 'skill', resource: id, effect: 'allow' as const })),
  ]
}

export function applyOrchestrator(editor: AgentEditor, config: OrchestratorConfig | undefined, managedCatalog?: ManagedCatalog) {
  if (!config) return
  // Native update() creates missing agents. The API is the single official prompt source.
  editor.update(config.id, draft => {
    draft.description = config.description
    draft.system = `[ame-orchestrator version=${config.version}]\n${config.prompt}`
    draft.mode = "primary" // Platform leads may delegate, but cannot recurse into the global root.
    draft.hidden = false
    draft.permissions = orchestratorPermissions(managedCatalog)
  })
  // Do not change the native default: translation/commit sessions have their own entry points.
}
