import { Plugin } from "@opencode/plugin"
type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
import type { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import { z } from "zod"
import { assertModel, managedProvider, MODEL_LEVELS, modelPolicy, parseModelLevel, providerURL, resolveModelLevel, type ModelLevels } from "../../amekit/src/model-policy"
import { modelGateway } from "./model-gateway"
import { OrchestratorConfig } from "../../amekit/src/orchestrator"
import { applyOrchestrator } from "./orchestrator"
import { createRootTodoGuard, AME_TODO_TOOL_DESCRIPTION, TODO_TOOL_NAME } from "./todo-policy"
import { createManagedCatalogGuard, EMPTY_MANAGED_CATALOG, ManagedCatalogSchema, normalizeManagedCatalog, type ManagedCatalog } from "./managed-catalog"
import { createToolOutputGuard } from "./tool-output-guard"
import { decideSessionRetry } from "./retry-policy"

type RuntimePolicy = { models: ReturnType<typeof modelPolicy>["models"]; default_model: string; model_levels: ModelLevels; chat_models?: ReturnType<typeof modelPolicy>["chat_models"]; feature_models?: readonly string[] }
type AgentModel = { id: string; model?: Model.Ref }
type AgentModelEditor = {
  list(): readonly AgentModel[]
  update(id: string, update: (agent: AgentModel) => void): void
}

export function orderPolicyModels(policy: RuntimePolicy) {
  return [...policy.models.filter(model => model.id === policy.default_model), ...policy.models.filter(model => model.id !== policy.default_model)]
}

export function formatModelLevelsSystemNote(policy: RuntimePolicy) {
  return `[amecode-model-levels]\nActive model tiers: default = amecode/${policy.model_levels.default} (workspace default); haiku = amecode/${policy.model_levels.haiku} (fast/light tasks); sonnet = amecode/${policy.model_levels.sonnet} (balanced coding); opus = amecode/${policy.model_levels.opus} (deep reasoning). Use the corresponding amecode/default, amecode/haiku, amecode/sonnet or amecode/opus tier when selecting an agent model.`
}

export function applyAgentModelTransform(editor: AgentModelEditor, policy: RuntimePolicy | undefined) {
  if (!policy) return
  for (const agent of editor.list()) {
    if (agent.model?.providerID !== managedProvider || !parseModelLevel(agent.model.id)) continue
    editor.update(agent.id, draft => {
      draft.model = { ...draft.model!, providerID: managedProvider as Model.Info["providerID"], id: resolveModelLevel(policy, draft.model!.id) as Model.ID }
    })
  }
}

export function resolveSubagentInputModel(input: { tool: string; input?: unknown }, policy: RuntimePolicy | undefined) {
  if (!policy || input.tool.trim().toLowerCase() !== "subagent") return
  if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) return
  const args = input.input as Record<string, unknown>
  if (typeof args.model === "string" && parseModelLevel(args.model)) {
    args.model = managedProvider + "/" + resolveModelLevel(policy, args.model)
  } else if (args.model && typeof args.model === "object" && !Array.isArray(args.model)) {
    const ref = args.model as { providerID?: unknown; id?: unknown }
    if ((ref.providerID === undefined || ref.providerID === managedProvider) && typeof ref.id === "string" && parseModelLevel(ref.id)) {
      args.model = { ...ref, providerID: managedProvider, id: resolveModelLevel(policy, ref.id) }
    }
  }
}

export function applyModelRequestHeaders(input: { sessionID: string; headers: Record<string, string> }) {
  for (const name of Object.keys(input.headers)) {
    if (["authorization", "api-key", "x-api-key"].includes(name.toLowerCase())) delete input.headers[name]
  }
  const hasSessionHeader = Object.keys(input.headers).some(name => name.toLowerCase() === "x-session-id")
  const sessionID = input.sessionID.trim()
  if (!hasSessionHeader && sessionID && sessionID.length <= 256 && !/[\r\n\x00]/.test(sessionID)) {
    input.headers["x-session-id"] = sessionID
  }
}

export function resolveHookModel(input: { kind: string; model: Model.Ref }, policy: RuntimePolicy | undefined) {
  if (!policy || input.model.providerID !== managedProvider) return
  const level = parseModelLevel(input.model.id)
  if (level) {
    input.model = { providerID: managedProvider as Model.Info["providerID"], id: policy.model_levels[level] as Model.ID }
  } else if (input.kind === "title") {
    const id = policy.models.some(model => model.id === policy.model_levels.haiku) ? policy.model_levels.haiku : policy.default_model
    input.model = { providerID: managedProvider as Model.Info["providerID"], id: id as Model.ID }
  }
  const singleChatModel = (policy.chat_models?.length ?? policy.models.length) === 1
  const isAuthorizedModel = policy.models.some(model => model.id === input.model.id)
  const isAuthorizedTierModel = MODEL_LEVELS.some(level => policy.model_levels[level] === input.model.id) && isAuthorizedModel
  const isAuthorizedFeatureModel = !!policy.feature_models?.includes(input.model.id) && isAuthorizedModel
  // Note (accepted tradeoff): OpenCode's experimental.model.resolve hook does not distinguish primary root chat from subagent calls here, so single-chat user accounts still allow authorized tier models (haiku/sonnet/opus) and authorized feature models at the OpenCode layer while desktop user chat locking is enforced in main IPC.
  if (singleChatModel && !(isAuthorizedTierModel || (input.kind !== "title" && isAuthorizedFeatureModel))) {
    input.model = { providerID: input.model.providerID, id: policy.default_model as Model.ID }
  }
}

const updateSchema = z.object({
  role: z.enum(["admin", "user"]), catalog: z.unknown(),
  featureModels: z.array(z.string().min(1).max(200)).max(20).optional(),
  orchestrator: OrchestratorConfig.optional(),
  managedCatalog: ManagedCatalogSchema.optional(),
  provider: z.object({ base_url: z.string(), api_key: z.string().min(1) }),
  expires: z.number().finite(),
}).nullable()
const key = Symbol.for("amekit.model-policy.v1")
type State = { policy?: ReturnType<typeof modelPolicy>; provider?: { base_url: string; api_key: string }; orchestrator?: OrchestratorConfig; managedCatalog?: ManagedCatalog; expires: number; listeners: Set<() => Promise<void>> }
const shared = globalThis as typeof globalThis & { [key]?: State }
const state = shared[key] ??= { expires: 0, listeners: new Set() }
function active() { return state.expires > Date.now() ? state.policy : undefined }
function check(model: { providerID: string; id: string }) { assertModel(active(), model) }

export default Plugin.define({
  id: "amekit-models",
  async setup(ctx: Context) {
    const todoGuard = createRootTodoGuard(sessionID => ctx.session.get({ sessionID: sessionID as Session.ID }))
    const catalogGuard = createManagedCatalogGuard({
      getCatalog: () => state.managedCatalog ?? EMPTY_MANAGED_CATALOG,
      getSession: sessionID => ctx.session.get({ sessionID: sessionID as Session.ID }),
      listAgents: () => ctx.agent.list().then(r => r.data),
    })
    const toolOutputGuard = createToolOutputGuard()
    const gateway = await modelGateway(() => { const policy = active(); return policy && state.provider ? { policy, provider: state.provider } : undefined })
    const registrations: { dispose(): Promise<void> }[] = []
    let agentTransformReg: { dispose(): Promise<void> } | undefined
    let reloading: Promise<void> = Promise.resolve()
    let disposed = false
    const agentTransform = (editor: Parameters<Parameters<Context["agent"]["transform"]>[0]>[0]) => {
      const policy = active()
      if (policy) applyOrchestrator(editor, state.orchestrator, state.managedCatalog)
      applyAgentModelTransform(editor, policy)
    }
    const registerAgentTransform = async () => {
      const prev = agentTransformReg
      agentTransformReg = undefined
      if (prev) await prev.dispose().catch(() => {})
      if (!disposed) agentTransformReg = await ctx.agent.transform(agentTransform)
    }
    const reload = () => {
      const next = reloading.then(async () => {
        if (disposed) return
        await ctx.provider.reload()
        await ctx.model.reload()
        // Re-register after opencode.config.agent so agent transforms see bundle Markdown agents.
        await registerAgentTransform()
        await ctx.agent.reload()
        await ctx.skill.reload()
      })
      reloading = next.catch(() => {})
      return next
    }
    let timer: ReturnType<typeof setInterval> | undefined
    const cleanup = async () => {
      disposed = true
      clearInterval(timer); state.listeners.delete(reload)
      await reloading.catch(() => {})
      const activeReg = agentTransformReg; agentTransformReg = undefined
      if (!state.listeners.size) { state.policy = undefined; state.provider = undefined; state.orchestrator = undefined; state.managedCatalog = undefined; state.expires = 0 }
      await Promise.all([gateway.close(), ...(activeReg ? [activeReg.dispose()] : []), ...registrations.reverse().map(registration => registration.dispose())])
    }
    try {
    registrations.push(await ctx.provider.transform(editor => {
      for (const record of editor.list()) editor.remove(record.provider.id)
      const policy = active()
      if (!policy) return
      const models: Model.Info[] = orderPolicyModels(policy).map(model => ({
        id: model.id as Model.ID, modelID: model.id as Model.ID, providerID: managedProvider as Model.Info["providerID"],
        name: model.name, capabilities: { tools: model.tool_call, input: model.vision ? ["text", "image"] : ["text"], output: ["text"] },
        variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
        limit: { context: model.context, output: model.output },
      }))
      editor.add({ info: { id: managedProvider as Model.Info["providerID"], name: "AMECODE", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", compatibility: { supportsPromptCacheKey: true }, settings: { baseURL: gateway.baseURL } }, models })
    }))
    registrations.push(await ctx.model.transform(editor => {
      const policy = active()
      for (const model of editor.list()) if (!policy || model.providerID !== managedProvider || !policy.models.some(entry => entry.id === model.id)) editor.remove(model.providerID, model.id)
      if (policy) editor.default.set(managedProvider, policy.default_model)
    }))
    await registerAgentTransform()
    registrations.push(await ctx.tool.transform(editor => {
      editor.update(TODO_TOOL_NAME, tool => { tool.description = AME_TODO_TOOL_DESCRIPTION })
    }))
    registrations.push(await ctx.tool.hook("execute.before", async input => {
      await todoGuard.assertBeforeExecute(input)
      await catalogGuard.assertBeforeExecute(input)
      resolveSubagentInputModel(input, active())
    }))
    registrations.push(await ctx.tool.hook("execute.after", async input => {
      toolOutputGuard.truncateAfterExecute(input)
    }))
    registrations.push(await ctx.session.hook("context", async input => {
      const policy = active()
      if (policy && !input.system.some(part => part.text.includes("[amecode-model-levels]"))) {
        input.system.push({ type: "text", text: formatModelLevelsSystemNote(policy) })
      }
      await todoGuard.filterContext(input)
      await catalogGuard.filterContext(input)
    }))
    registrations.push(await ctx.session.hook("experimental.model.resolve", async input => {
      resolveHookModel(input, active())
      check(input.model)
    }))
    registrations.push(await ctx.session.hook("model.request", async input => {
      check(input.model)
      input.baseURL = gateway.baseURL
      applyModelRequestHeaders(input)
    }))
    registrations.push(await ctx.session.hook("retry", async input => {
      decideSessionRetry(input)
    }))
    registrations.push(await ctx.session.hook("http.request", async input => {
      check(input.model)
      const target = new URL(input.request.url), base = new URL(gateway.baseURL)
      if (target.origin !== base.origin || !(target.pathname === base.pathname || target.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/"))) throw new Error("AMECODE_PROVIDER_MISMATCH")
      const headers = new Headers(input.request.headers)
      headers.delete("api-key"); headers.delete("x-api-key"); headers.delete("authorization")
      input.request = new Request(input.request, { headers, redirect: "error" })
    }))
    state.listeners.add(reload)
    registrations.push(await ctx.rpc.register({ id: "amekit-models", methods: {
      update: { input: updateSchema, output: z.boolean() },
      status: { input: z.null(), output: z.object({ authenticated: z.boolean(), models: z.array(z.string()) }) },
    }, events: {} }, {
      update: async value => {
        state.policy = undefined; state.provider = undefined; state.orchestrator = undefined; state.managedCatalog = undefined; state.expires = 0
        try {
          if (value) {
            const policy = modelPolicy(value.role, value.catalog, { featureModels: value.featureModels }), base_url = providerURL(value.provider.base_url)
            if (value.expires <= Date.now()) throw new Error("AMECODE_LOGIN_REQUIRED")
            state.policy = policy; state.provider = { ...value.provider, base_url }; state.orchestrator = value.orchestrator; state.expires = Math.min(value.expires, Date.now() + 24 * 60 * 60_000)
            state.managedCatalog = value.managedCatalog ? normalizeManagedCatalog(value.managedCatalog) : EMPTY_MANAGED_CATALOG
          }
        } finally {
          await Promise.all([...state.listeners].map(listener => listener()))
        }
        return true
      },
      status: async () => ({ authenticated: !!active(), models: active()?.models.map(model => model.id) ?? [] }),
    }))
    timer = setInterval(() => {
      if (state.policy && !active()) {
        state.policy = undefined; state.provider = undefined; state.orchestrator = undefined; state.managedCatalog = undefined; state.expires = 0
        void Promise.all([...state.listeners].map(listener => listener())).catch(() => {})
      }
    }, 1000)
    return cleanup
    } catch (error) {
      await cleanup().catch(() => {})
      throw error
    }
  },
})
