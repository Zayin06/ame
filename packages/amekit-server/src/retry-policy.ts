import type { SessionRetry } from "@opencode/plugin/promise/session"

const MAX_TRANSPORT_RETRY_ATTEMPT = 2
const TRANSIENT_TRANSPORT_RE = /ECONNRESET|socket connection was closed|connection lost|ETIMEDOUT|EPIPE|UND_ERR_SOCKET/i

/** Single-layer retry guard: preserves native 429/5xx retries and adds bounded backoff for transient transport drops. */
export function decideSessionRetry(input: Pick<SessionRetry, "error" | "attempt" | "decision">) {
  if (input.decision.retry) return
  if (input.attempt > MAX_TRANSPORT_RETRY_ATTEMPT) return
  if (input.error.type === "aborted") return
  const status = input.error.status
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) return
  if (input.error.type === "provider.transport" && TRANSIENT_TRANSPORT_RE.test(input.error.message)) {
    input.decision = {
      retry: true,
      delay: Math.min(8_000, 1_500 * (2 ** Math.max(0, input.attempt - 1))),
    }
  }
}
