import type { AmeApi } from "./api"
import { assertModel, managedProvider, modelPolicy, providerURL } from "./model-policy"
import { dialoguePrompt, parseDialogue, type DialogueSet } from "./pet-dialogue"

export async function generatePetDialogue(api: AmeApi | undefined, model: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<DialogueSet> {
  if (!api?.account) throw new Error("AMECODE_LOGIN_REQUIRED")
  await api.guard(false, signal)
  assertModel(modelPolicy(api.account?.role, api.provider?.catalog), { providerID: managedProvider, id: model })
  const provider = api.provider!.provider
  const response = await fetcher(providerURL(provider.base_url) + "/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider.api_key}` },
    body: JSON.stringify({ model, stream: false, max_tokens: 3000, messages: [{ role: "user", content: dialoguePrompt }] }),
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error("PET_PROVIDER_ERROR") }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("INVALID_PET_DIALOGUE")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 64 * 1024) { await reader.cancel(); throw new Error("PET_RESPONSE_TOO_LARGE") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== "string" || content.length > 24 * 1024) throw new Error("INVALID_PET_DIALOGUE")
  return parseDialogue(JSON.parse(content))
}
