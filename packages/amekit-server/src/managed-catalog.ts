import { z } from 'zod'
import { ORCHESTRATOR_AGENT_ID } from './todo-policy'

export const ManagedCatalogSchema = z.object({
  agents: z.array(z.string().min(1).max(200)).max(200),
  skills: z.array(z.string().min(1).max(200)).max(200),
}).strict()
export type ManagedCatalog = z.infer<typeof ManagedCatalogSchema>
export const EMPTY_MANAGED_CATALOG: ManagedCatalog = { agents: [], skills: [] }

export function normalizeManagedCatalog(catalog: ManagedCatalog = EMPTY_MANAGED_CATALOG): ManagedCatalog {
  const normalize = (values: readonly string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]
  return { agents: normalize(catalog.agents), skills: normalize(catalog.skills) }
}

type Identity = { agent: string; sessionID: string }
type Session = { agent?: string; parentID?: string }
type CatalogAgent = { id: string; mode: string; hidden?: boolean; description?: string }
type Context = Identity & {
  tools: Record<string, { description: string; input: unknown }>
  system: { type: string; text: string }[]
}
type Dependencies = {
  getCatalog(): ManagedCatalog
  getSession(sessionID: string): Promise<Session | undefined>
  listAgents(): Promise<readonly CatalogAgent[]>
}

const runtimeAgents = new Set(['compaction', 'title', 'summary'])
const emptySkills = 'No managed skills are currently active.'
const emptyAgents = '(No managed subagents are currently active. Do not fall back to native agents such as explore, general, or plan; report the missing capability or handle the task directly within your own permissions.)'

function filterSkills(text: string, allowed: ReadonlySet<string>) {
  return text.replace(/(<available_skills\b[^>]*>)([\s\S]*?)(<\/available_skills>)/gi, (_, open: string, content: string, close: string) => {
    const blocks = [...content.matchAll(/<skill\b([^>]*)>[\s\S]*?<\/skill>/gi)].map(match => match[0]).filter(block => {
      const attributes = /^<skill\b([^>]*)>/i.exec(block)?.[1] ?? ''
      const identifiers = [...attributes.matchAll(/(?:^|\s)(?:id|name)\s*=\s*(["'])(.*?)\1/gi)].map(match => match[2].trim())
      for (const match of block.matchAll(/<(id|name)(?:\s[^>]*)?>\s*([^<]*?)\s*<\/\1>/gi)) identifiers.push(match[2].trim())
      return identifiers.some(id => allowed.has(id))
    })
    return blocks.length ? `${open}\n${blocks.join('\n')}\n${close}` : emptySkills
  })
}

export function createManagedCatalogGuard(deps: Dependencies) {
  // Cache ancestry facts only: membership is always resolved from the live catalog.
  const sessions = new Map<string, Session>()
  async function session(id: string) {
    if (sessions.has(id)) return sessions.get(id)
    try {
      const value = await deps.getSession(id)
      if (!value) return
      if (sessions.size >= 500) sessions.delete(sessions.keys().next().value!)
      sessions.set(id, { agent: value.agent, parentID: value.parentID })
      return value
    } catch {
      return undefined
    }
  }
  const catalog = () => normalizeManagedCatalog(deps.getCatalog())

  async function isAmeWorkSession(agent: string, sessionID: string) {
    if (runtimeAgents.has(agent)) return false
    if (agent === ORCHESTRATOR_AGENT_ID) return true
    let id = sessionID
    const seen = new Set<string>()
    for (let depth = 0; depth <= 6; depth++) {
      if (seen.has(id)) break
      seen.add(id)
      const info = await session(id)
      if (!info) break
      // The current session's agent alone does not make a standalone session AME-owned.
      if (depth > 0 && info.agent === ORCHESTRATOR_AGENT_ID) return true
      if (!info.parentID) return false
      id = info.parentID
    }
    // Unknown ancestry must not bypass any active managed catalog.
    const active = catalog()
    return active.agents.length > 0 || active.skills.length > 0
  }

  async function visibleAgents(active: ManagedCatalog) {
    try {
      const allowed = new Set(active.agents)
      return (await deps.listAgents()).filter(agent => allowed.has(agent.id) && !agent.hidden && agent.mode !== 'primary').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    } catch {
      return []
    }
  }

  return {
    isAmeWorkSession,
    async filterContext(input: Context) {
      if (!await isAmeWorkSession(input.agent, input.sessionID)) return
      const active = catalog()
      const subagent = input.tools.subagent
      if (subagent) {
        const agents = await visibleAgents(active)
        const suffix = agents.length ? agents.map(agent => `- ${agent.id}: ${agent.description || 'Managed AME subagent.'}`).join('\n') : emptyAgents
        subagent.description = subagent.description.replace(/\n\nAvailable subagents:[\s\S]*$/, '') + `\n\nAvailable subagents:\n${suffix}`
      }
      for (const part of input.system) {
        if (part.text.includes('<available_skills')) part.text = filterSkills(part.text, new Set(active.skills))
      }
    },
    async assertBeforeExecute(input: Identity & { tool: string; input: unknown }) {
      if (runtimeAgents.has(input.agent)) return
      const tool = input.tool.trim().toLowerCase()
      if (tool !== 'subagent' && tool !== 'skill') return
      if (!await isAmeWorkSession(input.agent, input.sessionID)) return
      const active = catalog()
      const args = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {}
      const raw = tool === 'subagent' ? args.agent : args.id
      const target = typeof raw === 'string' ? raw.trim() : ''
      if (tool === 'subagent') {
        if (target && (await visibleAgents(active)).some(agent => agent.id === target)) return
        throw new Error(`MANAGED_SUBAGENT_FORBIDDEN: Subagent "${target || '(trống)'}" không thuộc catalog đang kích hoạt của AME. Không fallback sang agent ngoài danh sách (như explore, general, plan); hãy báo rõ thành phần bị thiếu hoặc tự xử lý trong quyền hiện có.`)
      }
      if (target && active.skills.includes(target)) return
      throw new Error(`MANAGED_SKILL_FORBIDDEN: Skill "${target || '(trống)'}" không thuộc catalog đang kích hoạt của AME. Không fallback sang skill ngoài danh sách; hãy báo rõ thành phần bị thiếu hoặc tự xử lý trong quyền hiện có.`)
    },
  }
}
