# Standalone AmeKit main service

## Integration contract

Import `createAmeKit` from `packages/amekit/src/index.ts` **only in Electron main**, after `app.whenReady()`. No GUI-host `MainContext`, Solid, or plugin GUI runtime is used.

```typescript
import { createAmeKit } from "./packages/amekit/src/index"

const amekit = createAmeKit({
  userData: app.getPath("userData"),
  endpoint: () => connection && { url: connection.url, headers: connection.headers },
  project: async id => workspaceRegistry.require(id).directory,
  pickImport: async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })
    return result.canceled ? null : result.filePaths[0] ?? null
  },
  cli: absoluteOpenCodeExecutable,
})
```

The exact exported types are:

```typescript
type AmeKitOptions = {
  userData: string
  endpoint: () => { url: string; headers: Record<string, string> } | undefined
  project: (id: string) => Promise<string>
  pickImport: () => Promise<string | null>
  cli?: string
}
type AmeKit = {
  call(operation: string, payload: Record<string, string>): Promise<unknown>
  dispose(): Promise<void>
}
```

`createAmeKit` is synchronous; its service awaits asynchronous encrypted-session restoration internally. Results are JSON-safe objects, not serialized strings. A second optional `AmeKitDependencies` parameter supplies main-only fetch/Electron/discovery test doubles; never expose it to IPC. Errors contain stable uppercase codes, never network bodies, passwords, session tokens, or provider keys.

The host must validate trusted renderer origin/frame and payloads at its IPC boundary, keep passwords out of logs/history, and expose only `call`, not options, dependencies, the endpoint, or the API object. `payload.project` is a registered **project ID**, resolved by the main-only callback, never a renderer-controlled directory. Import always invokes the native picker; renderer `root` is ignored.

### Mandatory prompt guard

Before every backend prompt, main must await:

```typescript
const model = await amekit.call("assert-model", {
  modelID: requestedModel.id,
  providerID: "amecode",
}) as { providerID: string; modelID: string }
// Only after success, submit to the existing backend with model.
```

Model IDs are the API catalog's unprefixed `models[].id`; provider ID is always `amecode`. Missing `modelID` selects the account default. Explicit unauthorized IDs/providers are rejected, not silently coerced. `assert-ready` is an alias with the same behavior. This performs a fresh account check and successful policy RPC update before accepting a prompt. Do not treat renderer model lists or cached status as authorization. The existing server plugin additionally guards model resolution and requests.

## Required owner-managed backend

* Use an owner-managed OpenCode service's authenticated loopback endpoint; only `localhost`, `127.0.0.1`, and `::1` are accepted. Endpoint credentials stay main-only. Ame IDE's host starts its bundled private runtime/plugin by default and supplies its executable to discovery; external owner-managed services are an advanced opt-in. The Account service itself does not spawn the persistent backend.
* The backend owner must enable the existing OpenCode SDK **`amekit-models` server plugin**. It must support `POST /api/rpc/amekit-models/update` with `{input: policyOrNull}` and `{output:true}` acknowledgement. This service does **not** install/enable plugins, edit global OpenCode configuration, replace providers globally through configuration, restart a shared daemon, or send model requests.
* Missing/disabled plugin returns `MODEL_POLICY_PLUGIN_REQUIRED`; rejected/malformed/unreachable RPC returns `MODEL_POLICY_UNAVAILABLE`. Account/prompt access fails closed. The UI should present this blocker and explain owner action, not offer a bypass. A connected backend alone does not mean account policy is ready.
* Native bundle discovery requires the absolute executable path of **OpenCode 2.3.2**. The service verifies `--version`, launches only an isolated discovery child with model fetches, plugins, MCP and tools disabled, and cleans up that child and its isolated database. It never restarts the connected/shared service. No model requests are made. Raw/offline byte checks do not require this executable.

Call `logout` and await completion **before changing** the endpoint callback's result, including connect/discover. Do not switch endpoints during a running call. The server policy is shared across the owner's backend: use one service/account authority per endpoint; do not instantiate competing services for a shared policy. A busy operation rejects other calls with `OPERATION_BUSY` rather than racing login, filesystem transactions or prompts. Catch that code for background UI polling.

Await `dispose()` on shutdown; it stops the 30-second account refresh, aborts and drains in-flight work, clears memory and best-effort revokes policy on the current endpoint. Disposal is idempotent. Normal disposal retains only the encrypted resumable token. Logout deletes it. When a backend is unreachable, immediate remote revocation cannot be guaranteed; the existing server plugin's maximum 90-second policy lease expires without renewal. All local prompt guards reject while policy is unavailable.

## Operations

| Operation | String payload fields | Result / behavior |
| --- | --- | --- |
| `status` | none | Sanitized account/model policy and `ready`; or signed-out `{ready:false, blocker?}`; or reconnecting `{origin,reconnecting:true,ready:false,blocker}`. No credentials. |
| `login` | `username`, `password`, optional `server` | Fresh login and policy sync. Default server `https://amecode.ameno.tech`; HTTPS required except loopback development. |
| `refresh` | none | Fresh account, encrypted token persistence and policy sync; returns sanitized status. |
| `logout` | none | Removes encrypted token, revokes local model policy and best-effort remote session logout; returns null. |
| `assert-model` / `assert-ready` | optional `modelID`, `providerID` | Fresh authorization and RPC sync; returns `{providerID,modelID}`. |
| `latest` | none | `{release,revision,activatedAt}` for stable channel. |
| `history` | optional `cursor` | Admin-only `{releases,active,nextCursor}`. |
| `import` | optional `compatibilityMode`: `native` or `raw` | Admin picker and scan; `{issues,agents,skills,compatibilityMode,files:[{path,size}]}` or null on picker cancel. No contents returned. |
| `package` | `version` | Admin-only deterministic in-memory ZIP, `{sha256,summary,entries,expanded,size}`; requires successful import. |
| `publish` | none | Admin-only, internally confirmed upload of prepared package; returns Release. Does not activate. |
| `activate` | `id`, `revision` | Admin-only, internally confirmed activation with expected revision; returns Latest. |
| `sync` | `project`, optional `allowRaw`: `true` | Internally confirmed stable bundle download and transaction; returns sanitized install state plus `changed`. Raw additionally requires explicit flag **and** native warning confirmation. |
| `installed` | `project` | Verified ownership state `{version,releaseId,compatibilityMode,verification,compatibilityWarnings}` or null. |
| `offline` | `project` | Last-known-good ownership/hash check; native runtime discovery required; raw byte verification only. Returns state plus `changed:false`; no account/network dependency. |
| `uninstall` | `project` | Internally confirmed removal of unmodified owned files only; `{changed}`; no account dependency. |

Electron main `dialog.showMessageBox` gates every local install/uninstall, publish and activation with **Cancel as default**. A renderer boolean never substitutes for confirmation. Cancellation throws `CANCELLED`. Import reads files, package stays in memory, and neither changes project files.

Normal users see only the API `default_model`; admins see the validated full catalog, initially selecting `default_model` rather than the first catalog entry. An explicit admin Chat selection is retained while that model remains available. Account status exposes `models.model_levels` for `default`, `haiku` (fast/light tasks), `sonnet` (balanced coding), and `opus` (deep reasoning). Without an API tier map, admin tiers fall back to the default model except `haiku`, which uses `small_model`; all user tiers resolve strictly to `default_model`. Portable agent references `amecode/default`, `amecode/haiku`, `amecode/sonnet`, and `amecode/opus` resolve through the active policy in the plugin and gateway before concrete-model authorization. The Chat picker and Account tab display these mappings.

Admin AI Auto-Fix for both agents and skills always uses the API `default_model`, ignoring any caller model override or Chat selection. The import fix bar and applied-fix cards identify the default model used. Invalid/missing roles, expired sessions, malformed catalogs, failed refresh/storage/RPC suspend model access. Provider URL validation prevents non-HTTPS remote provider URLs. Only session origin/token are encrypted on disk via Electron `safeStorage`; provider keys and passwords are never persisted. Unavailable encryption or Linux `basic_text` storage fails with `SESSION_STORAGE_UNAVAILABLE`; there is no plaintext fallback. Native OS encryption is a runtime prerequisite.

## Bundle safety and compatibility

The reused validator enforces ZIP central/local header agreement, CRC/SHA-256, declared inventory, allowed paths, Unicode/case collisions, size/count/expansion limits, no symlinks/reparse paths, credential-path exclusions and secret checks. Both modes require agent and skill entrypoints. Native accepts portable `amecode/default|haiku|sonnet|opus` model references, but rejects unsupported metadata, concrete model pins and unresolved runtime/delegation dependencies. Raw preserves bytes and downgrades semantic incompatibilities to warnings, **not** structural, credential or secret errors. Raw-adapt normalizes bare or prefixed tier names (case-insensitively) into portable references while still removing `model: inherit`.

Install uses project-local `.opencode` and `.amekit` ownership, lock, stage, backup and transaction journal. Personal content/collisions and edited owned files block replacement/uninstall. Native installs must discover all expected agents and the exact project skill entrypoint paths, otherwise rollback restores the prior tree. Raw installs deliberately skip discovery and report **`verified-bytes`**, never `runtime-ready`. Interrupted transactions report `RECOVERY_REQUIRED`; automatic destructive recovery is intentionally not provided. Backups/evidence may remain in `.amekit` for recovery.

Discovery scratch databases are under `userData/amekit-runtime`, not the system temporary directory. The injected `userData`, registered project directories and executable are trusted main-owned resources. Ordinary filesystem checks do not provide protection against a privileged local attacker racing directory replacements.

## Provenance

Local source reused/adapted from this checkout's `opencode-amekit/src`: `api.ts`, `model-policy.ts`, `installer.ts`, `runtime.ts`, and `bundle/{archive,limits,manifest,package,scan}.ts`. These retain existing API/role, archive, ownership/rollback and native-vs-raw safeguards. Changes remove GUI contract imports, relocate discovery storage, verify CLI version, and strengthen key validation. `index.ts` and filesystem `session-vault.ts` provide the new standalone Electron-main orchestration and encrypted persistence. No Solid components, GUI-host main context, model gateway, global config writer, or GUI framework sources are copied.

## Focused verification

From `ide`:

```powershell
node --import tsx --test packages\amekit\test\amekit.test.ts
.\node_modules\.bin\tsc.cmd --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --esModuleInterop --skipLibCheck --types node packages\amekit\src\index.ts packages\amekit\test\amekit.test.ts
```

Tests use deterministic fixture APIs, RPC acknowledgements, encryption/discovery doubles and main dialogs only. They do not contact real accounts/APIs, submit model requests, alter global configuration, or start the actual CLI. These focused fixture tests do not validate OS safeStorage or real Account APIs. Host runtime and desktop smoke tests separately run the bundled plugin and backend; runtime integration also confirms project agent discovery. Full bundle import/sync native discovery and real-account login still require integration validation.
