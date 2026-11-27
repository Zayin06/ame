# ADR-001: Own the OpenCode runtime and IDE language/debug services

**Status:** Accepted

## Context

Ame IDE needs reproducible agent behavior, account-aware model access, and editor
services that remain responsive independently of a chat session. A shared external
OpenCode server would couple availability, configuration, credentials and upgrades
to software outside the IDE's lifecycle.

## Decision

- Bundle a private OpenCode **2.3.2** runtime, with matching pinned client/plugin
  dependencies. `PrivateRuntime` validates the packaged manifest/version/hash,
  owns the child process and uses an isolated profile. Communicate over HTTP/SSE
  on `127.0.0.1` with an ephemeral port and a generated password (HTTP Basic auth),
  not an unauthenticated LAN listener. External servers remain an explicit advanced
  option, not the default dependency.
- Load the internal **`amekit-models`** plugin and route provider requests through
  **`modelGateway`**. Its private loopback route enforces model/account policy and
  supplies provider credentials at the gateway rather than exposing upstream keys
  to the renderer or relying on a user's global provider configuration.
- Own dedicated IDE TypeScript language-service and Node debugger infrastructure
  instead of delegating editor behavior to the agent's generic LSP clients.
  TypeScript work runs in an IDE worker shared across workspace-specific engines;
  it is not one worker per project. Debugger services are project-scoped and launch
  Node with `--inspect-brk=127.0.0.1:0`, speaking CDP to the real inspector. This
  keeps editor overlays, diagnostics, breakpoints, stepping and variable inspection
  tied to IDE state and independent of agent execution.

## Provider API key scoping and enforcement

Provider `api_key` provisioning and authoritative enforcement of key scope belong
server-side in **`amecode-api`**, outside this IDE desktop repository. That service
is responsible for issuing appropriately scoped keys and enforcing account,
provider and model permissions on every request; desktop checks cannot substitute
for server-side authorization or constrain a key used outside the desktop app.

The desktop model policy checks and private `modelGateway` are complementary
defense-in-depth controls: they restrict the models exposed through the IDE and
keep upstream credentials out of the renderer. Changes to provider key issuance,
scope or server-side enforcement must be implemented and verified in
`amecode-api`, alongside—not replaced by—these desktop model policy checks.

## Consequences

The IDE starts with a known protocol and policy surface, owns startup/shutdown,
and avoids interference from global OpenCode configuration or another application's
server. Language work stays off the UI thread and debugging uses native Node
semantics. Loopback authentication reduces accidental access; it is not a sandbox
against a compromised local account.

We accept larger platform-specific artifacts, responsibility for runtime security
updates and compatibility testing, and maintenance of the plugin, worker and CDP
integration. Generic multi-language LSP support would require a separate decision.

## Implementation references

- `packages/opencode-adapter/src/runtime.ts`, `src/index.ts`
- `packages/amekit-server/src/server.ts`, `src/model-gateway.ts`
- `packages/ide-core/src/ts-lsp.ts`, `src/ts-lsp-worker.ts`, `src/debugger.ts`
- `docs/architecture.md`
