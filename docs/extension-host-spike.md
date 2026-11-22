# TASK-013 — Extension host architecture spike / ADR-001

Status: **Proposed; no extension host or VS Code compatibility is implemented by this ADR.**

## Context and observed boundaries

Ame IDE is an Electron desktop app with a React **19.2.0** shell and Monaco **0.55.1**, not a Code-OSS workbench. The second execution boundary is its private **OpenCode 2.3.2** process. The Electron renderer has context isolation, sandboxing and no Node integration. Mobile pairing is an authenticated gateway into that backend, not a transport for Electron APIs or desktop plugin execution.

Verified code anchors (paths relative to this document):

| Source | Existing responsibility and consequence |
| --- | --- |
| [Main entry](../apps/desktop/src/main/index.ts): `openWindow`, `schema`, `call`, `dispatch`, `resolveModel` | Explicit Zod-validated bridge, trusted main-frame ownership, serialized authority operations and native confirmations. New extension methods need a separate broker, not access to `ame:call` or `window.ame`. `resolveModel` forces a User's server-fixed canonical model; admins can choose only catalog-authorized models. |
| [Protocol](../packages/protocol/src/index.ts): `DesktopApi`, `IdeEvent` | Shared typed renderer contracts. These are not an extension SDK and must not be exposed wholesale to plugins. |
| [TypeScript service](../packages/ide-core/src/ts-lsp.ts): `createTsLanguageService`, `TsLanguageService` | Native TypeScript language service with in-memory overlays, workspace path checks and read-only rename previews. It is not a generic LSP server or VS Code language extension host. |
| [Node debugger](../packages/ide-core/src/debugger.ts): `createNodeDebugger`, `NodeDebugger` | Owned child/inspector lifecycle, workspace validation, bounded requests and Node startup override filtering. It is not a DAP host; debug evaluation and launch are execution privileges, not diagnostics privileges. |
| [AmeKit](../packages/amekit/src/index.ts): `createAmeKit` | Main-only Account access, refresh/revocation, policy RPC synchronization, bundle scan/package/install and explicit native confirmations. Ordinary `user` and `admin` roles are Account/model-policy concepts, not implicit extension permissions. |
| [Session vault](../packages/amekit/src/session-vault.ts): `openSessionVault` | Credentials encrypted with Electron `safeStorage`, plaintext-backend rejection, validated private path and atomic saves. This is never a plugin secret service. |
| [Adapter](../packages/opencode-adapter/src/index.ts): `OpenCodeAdapter` | Exact-version generated SDK, project/session ownership, authenticated local endpoint and SSE. `endpoint()` carries credentials and stays trusted-main-only. Commands/skills come from native backend discovery. |
| [Runtime](../packages/opencode-adapter/src/runtime.ts): `PrivateRuntime` | Validates staged runtime, owns private profile/auth/readiness/stop; filters inherited Node/Electron/OpenCode configuration. Plugins cannot create a second policy authority or select external backend credentials. |
| [Pairing](../packages/opencode-adapter/src/remote-pairing.ts), [gateway](../packages/opencode-adapter/src/pairing.ts) | Private tunnel identity and device-token forwarding; do not extend mobile device authority to arbitrary desktop plugin methods. |

### Bundle trust is not yet publisher signing

[Bundle scan](../packages/amekit/src/bundle/scan.ts), [packaging](../packages/amekit/src/bundle/package.ts), [manifest validation](../packages/amekit/src/bundle/manifest.ts) and [installer](../packages/amekit/src/installer.ts) already bound ZIP/file sizes, reject unsafe paths and links, scan likely secrets, verify SHA-256 inventories, protect personal files and roll back failed native discovery. The accepted content is **agents/ and skills/**, not arbitrary extension payloads. Raw compatibility mode does not certify runtime readiness.

These local checks establish byte integrity against release metadata; they do **not** implement an independently verified publisher signature. Bundle signing for broader extensions needs a versioned signed manifest, trusted publisher roots, key rotation/revocation and offline verification. Do not describe hash verification, Account authorization or a secret scan as code signing. Executable/native payloads must not be admitted through today's raw mode as a shortcut.

## Options and comparison

All resource/latency entries below are engineering expectations, **not measured claims**. Compare deltas against an identical packaged baseline on Windows x64 and macOS x64/arm64 before promotion.

| Dimension | A — Ame Lightweight Extension Host: Electron UtilityProcess + capability-gated JSON-RPC | B — Eclipse Theia (`@theia/plugin-ext`) | C — Fork Code-OSS extension host (`vscode` API host / `vscode-ripgrep`) |
| --- | --- | --- | --- |
| Startup latency | Lazy host activation; declarative contributions need no Node host. Expected smallest incremental startup cost. Measure first activation separately. | Plugin lifecycle plus Theia services/DI/workbench adaptation add startup work. Monaco alone does not supply them. | Extension scanning/activation and many workbench services add startup work even if lazily loaded. Requires adapting pinned upstream internals. |
| RAM / bundle | One host per effective grant/trust group adds a process; cap hosts and idle-terminate. Smallest expected dependency increment, but isolation increases RAM. | Extra framework/services/plugin runtime and potentially duplicated shell abstractions. Must measure bundled dependency graph. | Large API/service dependency surface plus host processes and native search artifacts. A standalone `vscode-ripgrep` binary is not an extension host. |
| `.vsix` ecosystem | No compatibility initially; custom manifest only. Phase 6C is explicitly partial. | Broad subset via Theia's VS Code plugin compatibility, not full fidelity; product-specific services still differ. | Closest APIs at a pinned upstream revision, not automatic full workbench/proposed-API compatibility. Marketplace distribution/use terms and extension licenses need review. |
| AmeKit isolation | Broker can withhold credentials and model routing entirely. Scrub `NODE_OPTIONS`, `BUN_OPTIONS`, internal tokens and backend environment. UtilityProcess alone is **not an OS sandbox**. | Existing plugin APIs are broad and require audit/restriction; same-user Node plugins remain able to access files/network absent OS controls. | VS Code APIs and Node execution are broad. Private vault/backend policy is not protected merely by moving execution to a child. Extensive broker and OS isolation work remains. |
| Windows / macOS packaging | Use Electron's shipped utility-process runtime; no new native addon for phase 6A. Validate ASAR paths, Windows signing, macOS helper entitlements/hardened runtime. | Extra assets, plugin scanners, runtime paths and possible native dependencies; integrates poorly with a fixed independent React shell without adapters. | Additional native binaries, API version pinning, licenses/notices, ASAR unpack rules and architecture-specific signing/notarization. |
| Maintenance | Own narrow SDK, manifest migrations, broker schema and lifecycle; lowest initial scope but host hardening is real work. | Upstream releases help compatibility; adapting framework assumptions and custom policy remains substantial. | Highest long-term fork/rebase burden and security-update lag; recreating services can become a workbench rewrite. |

**Decision:** choose A incrementally. Reject B/C for the immediate slice: neither is a drop-in safe compatibility switch for the existing React/Monaco shell. Revisit only with concrete enterprise extension requirements and measured cost. Do not claim an app-signing certificate grants trust to third-party bundles.

## Phased strategy: 6A → 6B → 6C

### 6A — Declarative contributions, immediate / low risk

1. Continue delivering existing agents and skills through the current AmeKit ZIP scan/validation/transaction/discovery path without changing its policy guarantees.
2. Propose a **new manifest version and allowlisted contribution validation** before adding themes, TextMate grammars/Monaco languages, slash commands or MCP descriptors. Today's schema rejects content outside agents/skills and cannot simply install `ame-extension.json` as-is.
3. Themes are validated token maps; TextMate/Monaco grammars are data-only, size/regex-limited and never an arbitrary module entry point. Monaco has language APIs, not a complete VS Code TextMate/workbench integration; tokenization adapters may be needed.
4. Slash commands/skills remain backend-native discovery and invoke only existing policy-checked model flows. Prompt data is untrusted content, not authority to grant permissions or change model/provider policy.
5. MCP descriptors are inert metadata. Network targets, transport, server executable/arguments and any secrets need separate broker validation and explicit user approval before activation. Descriptors must not auto-run a local process or inherit backend tokens. Remote pairing must not silently approve desktop capabilities.
6. Introduce signed distribution metadata before expanding beyond today's trust scope; retain collision checks, byte verification, safe extraction, rollback and offline last-known-good behavior.

Exit gate: malformed/oversized/path-escaping contributions fail closed; install/uninstall preserves personal files; no new process or credential flow on install; native agents/skills discovery still passes. Grammar/theme/descriptor data needs dedicated validation tests when implemented.

### 6B — Permission-isolated native plugin hosts

Use `utilityProcess.fork` from trusted main with a fixed bundled bootstrap and **explicit allowlisted environment**, never a renderer-provided executable. Activate lazily, group only by identical effective grant set, publisher/trust identity and project, and use a separate host when any differs. Do not share untrusted plugins with trusted ones just to reduce RAM.

Capability examples: `workspace.read`, `editor.diagnostics`, `ui.panel`. None implies workspace writes, terminal/debug execution, unrestricted network, general Electron IPC, `window.ame`, Account login, vault reads or `amekit-models` RPC access. File access is a broker operation with registered project IDs, canonical path validation, symlink checks, byte limits and cancellation. Diagnostics have bounded ranges/counts; panels use a separate sandboxed renderer, restricted CSP, no Node/preload bridge and mediated messages. Prefer declarative panel trees; any HTML must be isolated, never inserted into the trusted shell.

On spawn strip inherited `NODE_OPTIONS`, `BUN_OPTIONS`, `ELECTRON_*`, `OPENCODE_*`, `XDG_*`, service credentials and provider keys; supply only required OS/runtime paths and plugin-private state. Never give a plugin the userData/backend/vault path or the authenticated adapter endpoint. Environment scrubbing is necessary, **not sufficient**.

**Important boundary:** a native Node UtilityProcess runs with the same OS user by default. It can bypass a JSON-RPC broker via its filesystem/network/process APIs. Therefore it is crash isolation and a capability API design, not a hostile-code security sandbox. Protecting the vault and backend from malicious native plugins requires enforced OS filesystem/network/process isolation (with platform-specific feasibility validation), or keeping execution disabled for untrusted publishers. Until that exists, only explicitly trusted native code may run, with a clear trust warning. A VM context or removing SDK methods does not fix this limitation.

Host lifecycle: authenticate a main-created MessagePort, bind identity to the port (not client fields), handshake protocol version/digest/grants, serialize bounded frames, enforce request deadlines and cancellation, rate-limit, revoke ports before stopping, cap restart attempts and report crashes without restarting Account/runtime. Project close/logout/permission changes invalidate relevant grants; no stale host may renew a policy lease. Native plugin processes must not own or stop OpenCode.

Exit gate: broker tests deny unknown methods/cross-project paths, reject stale grants/replay/oversized responses, and demonstrate crash/revocation cleanup; signed packaged lifecycle and policy tests pass on both OS families. Do not call untrusted native execution sandboxed until OS enforcement tests prove it.

### 6C — Optional selective VS Code API compatibility

Create a narrow `@ame/vscode-compat` adapter **only** for named enterprise extensions after inventorying their API calls, licenses, native dependencies and backend expectations. Start with commands/languages/diagnostics, not terminal/debug/process/secrets APIs. Publish an explicit supported-API/version matrix and fail unsupported calls deterministically. Do not rewrite the workbench, promise general `.vsix` support or bundle Marketplace code without authorization. Reuse native TypeScript/debugger services only through reviewed adapters and separately granted execution capabilities; no direct API-to-main passthrough.

## Proposed manifest (not accepted by the current installer)

```json
{
  "schemaVersion": 1,
  "id": "example.typescript-hints",
  "version": "0.1.0",
  "engines": { "ame": ">=0.1.0 <0.2.0", "extensionProtocol": 1 },
  "kind": "native",
  "entry": "dist/host.mjs",
  "activationEvents": ["onLanguage:typescript"],
  "capabilities": ["workspace.read", "editor.diagnostics", "ui.panel"],
  "contributes": { "commands": [{ "id": "example.hints.show", "title": "Show hints" }] }
}
```

`ame-extension.json` is strict JSON with no unknown fields, normalized publisher-qualified IDs, bounded semver/engine ranges, allowlisted activation events, contribution limits and package-relative canonical entry paths. Declarative kind forbids executable entries. An entry is not permission to execute during install. A separate signed inventory binds manifest and payload hashes; signatures cover canonical bytes and package identity/version, not a mutable download URL. Reject links, traversal, duplicate/case-colliding paths and unsupported native modules; do not reuse raw agent compatibility mode to evade these rules. Declared capabilities are a request; effective grants live in main-managed per-project consent state and can be narrower.

## Proposed IPC / JSON-RPC 2.0 contract

Transport: one private main-created MessagePort per host, not public HTTP, remote pairing or the existing renderer `ame:call`. Every request is validated against a discriminated schema with `additionalProperties: false` before dispatch. Conceptual wire schemas:

```typescript
type Request =
  | { jsonrpc: '2.0'; id: number; method: 'host.initialize'; params: { protocol: 1; manifestSha256: string } }
  | { jsonrpc: '2.0'; id: number; method: 'workspace.read'; params: { projectID: string; path: string } }
  | { jsonrpc: '2.0'; id: number; method: 'editor.diagnostics'; params: { projectID: string; path: string; diagnostics: { line: number; column: number; message: string; severity: 'error' | 'warning' | 'info' }[] } }
  | { jsonrpc: '2.0'; id: number; method: 'ui.panel'; params: { panelID: string; title: string; text: string } }
type Response =
  | { jsonrpc: '2.0'; id: number; result: unknown }
  | { jsonrpc: '2.0'; id: number | null; error: { code: number; message: string } }
type Cancel = { jsonrpc: '2.0'; method: '$/cancelRequest'; params: { id: number } }
```

Normative proposed bounds: positive safe-integer IDs, at most 32 in-flight requests per port, 1 MiB UTF-8 frames, 5-second broker deadlines, workspace text reads capped at 512 KiB, 1,000 diagnostics per publication, one-based bounded positions, bounded text-only errors, no absolute paths or `..` segments, and 64 KiB panel text. Error codes: `-32700` parse, `-32600` invalid request, `-32601` unknown method, `-32602` invalid params, `-32001` denied/revoked, `-32002` timeout, `-32800` cancelled. Results need per-method schemas too; no arbitrary serialized Node objects/stacks/headers. Permission identity, grant epoch and project scope come from the broker's port binding, never from self-asserted plugin IDs. Initialization is allowed once and grants no authority by itself.

## Threat model and unresolved decisions

| Threat / boundary | Required response |
| --- | --- |
| Malformed ZIP, traversal, symlink/reparse or supply-chain replacement | Existing bounded scan/inventory/transaction mechanisms plus new versioned allowlist and publisher signatures; verify again before activation. Hashes alone do not establish publisher identity. |
| Untrusted renderer or plugin impersonates another extension/project | Separate ports, main-owned identity/grant epochs, schema validation and canonical workspace checks. No generic IPC forwarding. |
| Vault/backend/provider exposure or model-policy changes | No raw credential APIs, no model-policy update RPC, no mutable backend endpoint. All model operations still use `resolveModel`/AmeKit and server enforcement. OS isolation or trusted-code-only execution is required for same-user native plugins. |
| MCP/skill prompt injection or panel script execution | Treat descriptors/prompts as untrusted data, approve execution/network separately, isolate panels and enforce CSP. Installation is not consent to execute. |
| Denial of service / orphan host / malicious native addon | Time/size/concurrency budgets, restart caps, owned-process teardown and signed architecture-specific payload review. UtilityProcess does not impose CPU/memory hard limits or guarantee detached-child cleanup. |
| Mobile-to-desktop privilege escalation | Keep pairing/device permissions backend-scoped; desktop extension consent cannot be issued through a model prompt or device token. |

Open questions: which enterprise extensions justify 6C; trusted publisher/key management ownership; precise OS isolation mechanism and network controls on Windows/macOS; native addon policy and Electron ABI rebuild/signing budget; language grammar licensing and tokenizer performance; consent UX and workspace trust transitions; extension storage quotas/migration; crash attribution without leaking workspace text; future mobile declarative contribution parity. These are implementation gates, not solved features.

## Measurement and packaging gates

The new standalone scripts do not alter CI/release workflows or package scripts. After the app owner finishes building/packaging, run from the repository root:

```powershell
node scripts\smoke-packaged.mjs --executable 'C:\path\to\win-unpacked\Ame IDE.exe'
node scripts\benchmark-desktop.mjs --executable 'C:\path\to\win-unpacked\Ame IDE.exe' --json --threshold-startup-ms 15000 --threshold-heap-mb 512
```

Both accept `AME_IDE_PACKAGED_EXECUTABLE`; benchmark alone falls back to installed Electron with `.` when no unpacked app exists. Discovery prefers `release`, then lexical `release-*`; pass an explicit path when comparing builds or architectures. On macOS, select the `.app/Contents/MacOS/Ame IDE` binary and verify `Contents/Resources`. Resource checks cover non-empty staged OpenCode (including platform/architecture subdirectories), bundled policy `server.js`, and SHA-256 equality of packaged/repository pet sprites.

Profiles/projects live only in a temporary directory. Both pass `--user-data-dir` because packaged main deliberately ignores the development-only `AME_IDE_TEST_DATA` override. No login, model prompt or remote tunnel is requested. Startup is spawn-to-bridge plus `.app-shell` readiness; first paint is navigation-relative, not the same clock origin. Heap metrics cover the selected renderer only; process-tree RSS is a best-effort instantaneous working-set sum (may double-count shared pages), not peak RAM. Unavailable RSS/paint is `null`; missing required ready/heap measurements fails thresholds. Thresholds are inclusive and apply only to startup and used heap; defaults are operational gates, not an extension-overhead budget.

Repeat baseline/extension runs on idle hardware with identical signed/unsigned build state, architecture and project, report warm/cold runs and median/p95, then define incremental 6B budgets. A passing helper suite/typecheck does not certify packaged startup, OS sandboxing, signing/notarization, mobile behavior, real Account login or provider policy. Existing release workflow pins OpenCode 2.3.2 across Windows x64/macOS x64/arm64, rebuilds node-pty for Electron and conditionally signs; existing CI does not run these new CLIs. Integration into those workflows is a separate owner change.
