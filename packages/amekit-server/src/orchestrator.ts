import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { OrchestratorConfig } from "../../amekit/src/orchestrator"

export function applyOrchestrator(editor: AgentEditor, config: OrchestratorConfig | undefined) {
  if (!config) return
  // Native update() creates missing agents. Preserve effective project/global tool rules.
  const permissions = editor.get("build")?.permissions.map(rule => ({ ...rule }))
  editor.update(config.id, draft => {
    draft.description = config.description
    draft.system = `[ame-orchestrator version=${config.version}]\n${config.prompt}`
    draft.mode = "primary" // Platform leads may delegate, but cannot recurse into the global root.
    draft.hidden = false
    if (permissions) draft.permissions = permissions
  })
  // Do not change the native default: translation/commit sessions have their own entry points.
}
