import { z } from "zod"

/** API-owned instructions; the runtime owns tools, permissions and execution. */
export const OrchestratorConfig = z.object({
  id: z.literal("ame-orchestrator"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
  description: z.string().trim().min(1).max(1000),
  prompt: z.string().trim().min(1).max(16000),
  subagentDepth: z.literal(3),
}).strict()

export type OrchestratorConfig = z.infer<typeof OrchestratorConfig>
