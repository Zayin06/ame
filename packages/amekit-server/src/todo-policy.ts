export const TODO_TOOL_NAME = 'todowrite'
export const ORCHESTRATOR_AGENT_ID = 'ame-orchestrator'
export const AME_TODO_POLICY_MARKER = '[ame-todo-policy]'

const rules = `Only the level 0 ${ORCHESTRATOR_AGENT_ID} in the root session (parentID absent) may own and update the master todo list. Child sessions and subagents report results to AME and never write the master todo, even when their agent is ${ORCHESTRATOR_AGENT_ID}.
A todo list is mandatory for tasks with >=3 distinct deliverables (separate outcomes), or an explicit checklist. Count outcomes, not files, tools, or response length. Create the list immediately if this scope is discovered mid-run.
Use statuses pending, in_progress, completed, and cancelled. Multiple in_progress items are explicitly allowed for independent parallel work: coordinate dependencies, file scope, and shared resources, and avoid assigning subagents to the same file.
AME updates progress only after actual checks and when scope changes. Never mark work completed on errors, failures, or stops; preserve unfinished work and its next action.
Keep one list per execution: follow-up user messages while running update the current execution's list. A new user task after the execution starts a fresh list.`

export const AME_TODO_TOOL_DESCRIPTION = `Update the AME master todo list. ${rules}`
export const AME_TODO_SYSTEM_NOTE = `${AME_TODO_POLICY_MARKER}\n${rules}`

type Identity = { sessionID: string; agent: string }
type TodoContext = Identity & {
  tools: Record<string, unknown>
  system: { type: string; text: string }[]
}

const normalizedTool = (name: string) => name.trim().toLowerCase()

export function createRootTodoGuard(getSession: (sessionID: string) => Promise<{ parentID?: string } | undefined>) {
  const roots = new Map<string, boolean>()

  async function isAllowed(agent: string, sessionID: string) {
    if (agent !== ORCHESTRATOR_AGENT_ID) return false
    if (roots.has(sessionID)) return roots.get(sessionID)!
    let root = false
    try {
      const session = await getSession(sessionID)
      root = !!session && !session.parentID
    } catch {
      // A failed lookup must never grant access to the master list.
    }
    if (roots.size >= 500) roots.delete(roots.keys().next().value!)
    roots.set(sessionID, root)
    return root
  }

  return {
    isAllowed,
    async filterContext(input: TodoContext) {
      if (await isAllowed(input.agent, input.sessionID)) {
        if (!input.system.some(part => part.text.includes(AME_TODO_POLICY_MARKER))) {
          input.system.push({ type: 'text', text: AME_TODO_SYSTEM_NOTE })
        }
        return
      }
      for (const name of Object.keys(input.tools)) {
        if (normalizedTool(name) === TODO_TOOL_NAME) delete input.tools[name]
      }
    },
    async assertBeforeExecute(input: Identity & { tool: string }) {
      if (normalizedTool(input.tool) !== TODO_TOOL_NAME) return
      if (!await isAllowed(input.agent, input.sessionID)) {
        throw new Error('TODOWRITE_FORBIDDEN: Chỉ ame-orchestrator ở phiên gốc mới được cập nhật todo.')
      }
    },
  }
}
