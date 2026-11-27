import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerSaveBlocker, screen, session, shell } from 'electron'
import * as fs from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PairingHost } from '../../../../packages/opencode-adapter/src/pairing'
import { PairingDeviceStore } from '../../../../packages/opencode-adapter/src/pairing-store'
import { RemotePairing, automaticTunnel } from '../../../../packages/opencode-adapter/src/remote-pairing'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { rendererSource, isRendererDocument } from './renderer-source'
import { readOsClipboardFiles } from './os-clipboard-files'
import { Workspaces } from '../../../../packages/ide-core/src/workspace'
import { validateWorkspacePath } from '../../../../packages/ide-core/src/workspace-fs'
import { detectUntrustedGitConfig, isHeadPushed } from '../../../../packages/ide-core/src/git-ops'
import { resolveDroppedPaths } from '../../../../packages/ide-core/src/dropped-attachments'
import { Terminals } from '../../../../packages/ide-core/src/terminal'
import { createTsLanguageService, type TsLanguageService } from '../../../../packages/ide-core/src/ts-lsp'
import { createNodeDebugger, type NodeDebugger } from '../../../../packages/ide-core/src/debugger'
import { OpenCodeAdapter } from '../../../../packages/opencode-adapter/src/index'
import { PrivateRuntime } from '../../../../packages/opencode-adapter/src/runtime'
import { createAmeKit } from '../../../../packages/amekit/src/index'
import { resolveModelLevel, type ModelLevels } from '../../../../packages/amekit/src/model-policy'
import { createPinnedSessionModelStore, buildCommitAnalysisPrompt } from '../../../../packages/amekit/src/commit-analysis'
import { canonicalWorkspaceScope, detectAndroidProject, buildAndroidTranslationPrompt, createTranslationLockStore } from '../../../../packages/amekit/src/android-translation'
import { createPetHost } from '../../../../packages/amekit/src/pet-host'
import { revealPetMainWindow } from '../../../../packages/amekit/src/pet-interaction'
import { loadPetSprite } from '../../../../packages/amekit/src/pet'
import type { UsagePrices } from '../../../../packages/amekit/src/usage-pricing'
import { GIT_COMMIT_HASH_PATTERN, type AndroidTranslationInfo, type AndroidTranslationPromptResult, type BuildNotesPreview, type BuildNotesResult, type IdeEvent, type Model, type SessionLockState } from '../../../../packages/protocol/src/index'

if (!app.isPackaged && process.env.AME_IDE_TEST_DATA) app.setPath('userData', path.resolve(process.env.AME_IDE_TEST_DATA))
const here = path.dirname(fileURLToPath(import.meta.url))
const renderer = rendererSource(app.isPackaged, here, process.env.ELECTRON_RENDERER_URL)
let window: BrowserWindow | undefined
let workspace: Workspaces
let terminals: Terminals
let adapter: OpenCodeAdapter
let account: ReturnType<typeof createAmeKit>
let translationLocks: ReturnType<typeof createTranslationLockStore> | undefined
let pinnedModels: ReturnType<typeof createPinnedSessionModelStore> | undefined
let petHost: ReturnType<typeof createPetHost> | undefined
let sprite = ''
let runtime: PrivateRuntime
let managed = true
let shuttingDown = false
let pairing: RemotePairing
let screenBlocker: number | undefined
const pairingSchema = z.object({ enabled: z.boolean(), keepScreenActive: z.boolean() }).strict()
function screenActive(enabled: boolean) {
  if (enabled && (screenBlocker === undefined || !powerSaveBlocker.isStarted(screenBlocker))) screenBlocker = powerSaveBlocker.start('prevent-display-sleep')
  if (!enabled && screenBlocker !== undefined) { if (powerSaveBlocker.isStarted(screenBlocker)) powerSaveBlocker.stop(screenBlocker); screenBlocker = undefined }
}
async function configurePairing(settings: z.infer<typeof pairingSchema>) {
  const result = await pairing.configure(settings)
  screenActive(result.keepScreenActive && !shuttingDown)
  try { await writeFile(path.join(app.getPath('userData'), 'pairing.json'), JSON.stringify({ enabled: result.enabled, keepScreenActive: result.keepScreenActive }), { mode: 0o600 }) }
  catch { await pairing.stop(); screenActive(false); throw new Error('PAIRING_SETTINGS_SAVE_FAILED') }
  return result
}
async function startBackend() {
  const switching = !managed
  if (switching) await account.call('logout', {})
  managed = true
  adapter.disconnected('Đang khởi động OpenCode tích hợp…')
  try {
    const endpoint = await runtime.start()
    if (shuttingDown) return adapter.connection()
    await adapter.connect(endpoint.url, endpoint.username, endpoint.password)
    const status = await account.call('status', {}) as { reconnecting?: boolean }
    if (status?.reconnecting) await account.call('refresh', {}).catch(() => {})
    return adapter.connection()
  } catch (error) {
    return adapter.disconnected(error instanceof Error ? error.message : 'RUNTIME_START_FAILED')
  }
}
const text = z.string().max(200000)
const trustedWorkspaces = new Set<string>()
let trustWrites: Promise<unknown> = Promise.resolve()
function trustFile() { return path.join(app.getPath('userData'), 'trusted-workspaces.json') }
async function loadWorkspaceTrust() {
  trustedWorkspaces.clear()
  try {
    const directories = z.array(z.string().min(1)).parse(JSON.parse(await readFile(trustFile(), 'utf8')))
    for (const directory of directories) trustedWorkspaces.add(directory)
  } catch { /* Missing or invalid trust never grants access. */ }
}
async function assertWorkspaceTrusted(projectID: string) {
  const directory = workspace.get(projectID).directory
  let canonical: string
  try { canonical = await fs.promises.realpath(directory) }
  catch { throw new Error('WORKSPACE_UNTRUSTED') }
  if (trustedWorkspaces.has(canonical)) return
  const entries = await detectUntrustedGitConfig(directory).catch(error => {
    // Terminals and debuggers also support projects without a Git repository.
    if (error instanceof Error && error.message === 'GIT_ROOT_REQUIRED') return []
    throw error
  })
  if (!entries.length) return
  try {
    await confirmation('Tin cậy workspace này?', `${canonical}\n.git/config / hooks có thể thực thi lệnh khi thao tác với workspace:\n${entries.join('\n')}`)
  } catch { throw new Error('WORKSPACE_UNTRUSTED') }
  if (shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  const save = trustWrites.catch(() => {}).then(async () => {
    if (trustedWorkspaces.has(canonical)) return
    const file = trustFile(), temporary = `${file}.${randomUUID()}.tmp`
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await writeFile(temporary, JSON.stringify([...trustedWorkspaces, canonical]), { mode: 0o600 })
      await fs.promises.rename(temporary, file)
      trustedWorkspaces.add(canonical)
    } finally { await fs.promises.rm(temporary, { force: true }) }
  })
  trustWrites = save
  await save
}
async function validatePromptFiles(projectID: string, files: z.infer<typeof promptFilesSchema> | undefined) {
  for (const item of files ?? []) {
    for (const uri of [item.uri, item.source?.type === 'uri' ? item.source.uri : undefined]) {
      if (!uri || !/^file:/i.test(uri)) continue
      try {
        const directory = workspace.get(projectID).directory
        const rootReal = await fs.promises.realpath(directory)
        const url = new URL(uri)
        if (url.search || url.hash) throw new Error('INVALID_FILE_URI')
        const absolute = fileURLToPath(url)
        const candidate = process.platform === 'darwin' ? absolute.replace(/^\/(?:var|tmp|etc)(?=\/|$)/, m => '/private' + m) : absolute
        const { target } = await validateWorkspacePath(rootReal, path.relative(rootReal, candidate))
        const info = await fs.promises.lstat(target)
        if (info.isSymbolicLink() || !info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('INVALID_ATTACHMENT')
      } catch { throw new Error('INVALID_ATTACHMENT: file URI must reference a regular workspace file outside .git, without symlinks, at most 10 MiB') }
    }
  }
}
// Support both Electron's legacy raw-format API and its newer ClipboardItem API.
async function osClipboardFiles(): Promise<string[]> {
  const legacy = clipboard as unknown as Parameters<typeof readOsClipboardFiles>[0]
  if (legacy.availableFormats || legacy.readBuffer) return readOsClipboardFiles(legacy, fs.existsSync)
  const buffers = new Map<string, Buffer>()
  for (const item of await clipboard.read()) {
    for (const type of item.types) {
      const raw = /^electron application\/osclipboard;format="([^"]+)"$/.exec(type)?.[1] ?? type
      if (!['cf_hdrop', 'filenamew', 'nsfilenamespboardtype', 'public.file-url', 'text/uri-list'].includes(raw.toLowerCase())) continue
      try {
        const blob = await item.getType(type)
        if ('arrayBuffer' in blob) buffers.set(raw, Buffer.from(await blob.arrayBuffer()))
      } catch { /* Another advertised format may still be readable. */ }
    }
  }
  return readOsClipboardFiles({ availableFormats: () => [...buffers.keys()], readBuffer: format => buffers.get(format) ?? Buffer.alloc(0) }, fs.existsSync)
}
const id = z.string().min(1).max(512)
const relative = z.string().max(4096).refine(value => !value.includes('\0'))
const workspacePath = relative.refine(value => value.length > 0)
const branchName = z.string().min(1).max(512).refine(value => !value.includes('\0'))
const commitOptionsSchema = z.object({ amend: z.boolean().optional(), noVerify: z.boolean().optional() }).strict()
const commitHashSchema = z.string().regex(GIT_COMMIT_HASH_PATTERN)
const buildNotesRequestSchema = z.object({
  mode: z.enum(['range', 'commits']),
  baseCommit: commitHashSchema.optional(),
  commitHashes: z.array(commitHashSchema).max(50).optional(),
  includeWorking: z.boolean(),
  note: z.string().max(2000).refine(value => !value.includes('\0')).optional(),
}).strict()
const sessionTitle = z.string().min(1).max(500).refine(value => !!value.trim() && !value.includes('\0'))
const modelSchema = z.object({ id, modelID: id.optional(), name: z.string().max(512), providerID: id }).strict()
const promptFileSchema = z.object({
  uri: z.string().min(1).max(15 * 1024 * 1024).refine(value => !value.includes('\0') && (/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(value) || /^file:\/\/\//i.test(value))),
  name: z.string().min(1).max(255).refine(value => !value.includes('\0')).optional(),
  mime: z.string().min(1).max(120).refine(value => !value.includes('\0')).optional(),
  source: z.union([
    z.object({ type: z.literal('inline') }).strict(),
    z.object({ type: z.literal('uri'), uri: z.string().min(1).max(4096).refine(value => !value.includes('\0')) }).strict(),
  ]).optional(),
}).strict()
const promptFilesSchema = z.array(promptFileSchema).max(8)
const boundedID = id.refine(value => !!value.trim() && !value.includes('\0'))
const formAnswerKey = z.string().min(1).max(200).refine(value => !!value.trim() && !value.includes('\0') && !['__proto__', 'prototype', 'constructor'].includes(value))
const formAnswerString = z.string().max(20000).refine(value => !value.includes('\0'))
const formAnswer = z.custom<Record<string, unknown>>(input => !!input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => formAnswerKey.safeParse(key).success))
  .pipe(z.record(formAnswerKey, z.union([formAnswerString, z.number().finite(), z.boolean(), z.array(formAnswerString).max(100)])))
  .refine(answer => Object.keys(answer).length <= 100 && JSON.stringify(answer).length <= 200000)
const artifactID = text.min(1).max(200).refine(value => value === value.trim() && !value.includes('\0'))
const question = text.min(1).max(20000).refine(value => !!value.trim() && !value.includes('\0'))
const petModel = z.string().min(1).max(200).refine(value => value === value.trim() && !value.includes('\0'))
const petConfigure = z.object({ enabled: z.boolean().optional(), scale: z.number().min(0.25).max(2).optional(), resetPosition: z.boolean().optional() }).strict()
const petSpeech = z.object({ enabled: z.boolean().optional(), sound: z.boolean().optional() }).strict()
const petColor = z.string().min(1).max(160).regex(/^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([a-z\d.,%+\- /]+\))$/i)
const petPalette = z.object({ background: petColor, foreground: petColor, border: petColor }).strict()
const petSession = z.object({
  key: boundedID, running: z.boolean(), waiting: z.boolean(), thinking: z.boolean(), child: z.boolean(),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  busy: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  idle: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
}).strict()
const content = z.string().max(4 * 1024 * 1024).refine(value => Buffer.byteLength(value, 'utf8') <= 4 * 1024 * 1024, 'FILE_TOO_LARGE')
const sourcePath = workspacePath.refine(value => !/^[\\/]|:/.test(value) && value.split(/[\\/]/).every(part =>
  part !== '..' && part.toLowerCase() !== '.git' && (!part || part === '.' || !/[. ]$/.test(part))) && value.split(/[\\/]/).some(part => part && part !== '.'))
const debugCwd = z.union([z.literal('.'), sourcePath])
const position = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const safeString = z.string().max(8192).refine(value => !value.includes('\0'))
const debugConfig = z.object({
  entry: sourcePath,
  args: z.array(safeString).max(100).optional(),
  cwd: debugCwd.optional(),
  env: z.record(z.string().min(1).max(200).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), safeString)
    .refine(value => Object.keys(value).length <= 100).optional(),
  runtime: z.enum(['node', 'tsx']).optional()
}).strict()
const searchQuery = z.object({
  query: z.string().max(20000),
  caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional(), regex: z.boolean().optional(),
  include: z.array(z.string().min(1).max(4096)).max(100).optional(),
  exclude: z.array(z.string().min(1).max(4096)).max(100).optional(),
  maxFiles: z.number().int().min(1).max(10000).optional(),
  maxMatches: z.number().int().min(1).max(100000).optional(),
  maxResponseBytes: z.number().int().min(256).max(1024 * 1024).optional()
}).strict()
const replaceOptions = searchQuery.extend({
  replacement: z.string().max(200000), files: z.array(workspacePath).max(5000).optional(), dryRun: z.boolean().optional()
}).strict()
const diffTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('staged'), from: workspacePath.optional() }).strict(),
  z.object({ kind: z.literal('working'), from: workspacePath.optional() }).strict(),
  z.object({ kind: z.literal('commit'), commit: commitHashSchema, from: workspacePath.optional() }).strict(),
  z.object({ kind: z.literal('range'), baseCommit: commitHashSchema, includeWorking: z.boolean().optional(), from: workspacePath.optional() }).strict(),
  z.object({ kind: z.literal('commits'), commits: z.array(commitHashSchema).min(1).max(50), includeWorking: z.boolean().optional(), from: workspacePath.optional() }).strict()
])
const schema = {
  stageRevert: z.tuple([id, id, z.string().min(1).max(200), z.boolean()]),
  clearRevert: z.tuple([id, id]),
  openExternal: z.tuple([z.string().min(1).max(2048).refine(value => {
    if (/[\u0000-\u0020\u007f-\u009f]/.test(value) || !/^https?:\/\//i.test(value)) return false
    try { const parsed = new URL(value); return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname } catch { return false }
  })]),
  platform: z.tuple([]),
  artifacts: z.tuple([boundedID, boundedID.optional()]), artifact: z.tuple([boundedID, artifactID]), deleteArtifact: z.tuple([boundedID, artifactID]),
  btwAsk: z.tuple([boundedID, boundedID, question, modelSchema.optional()]), forkSession: z.tuple([boundedID, boundedID]),
  petState: z.tuple([]), petSprite: z.tuple([]), petConfigure: z.tuple([petConfigure]), petSpeech: z.tuple([petSpeech]),
  petTheme: z.tuple([petPalette]), petReport: z.tuple([z.array(petSession).max(2000)]),
  petTestSpeech: z.tuple([]), petGenerateDialogue: z.tuple([petModel.optional()]),
  terminalProfiles: z.tuple([]), terminalList: z.tuple([id]),
  terminalCreate: z.tuple([id, id.optional(), z.number().int().min(2).max(500).optional(), z.number().int().min(1).max(300).optional()]),
  terminalSnapshot: z.tuple([id, id]), terminalWrite: z.tuple([id, id, z.string().max(65536)]),
  terminalResize: z.tuple([id, id, z.number().int().min(2).max(500), z.number().int().min(1).max(300)]), terminalClose: z.tuple([id, id]),
  lspUpdateDocument: z.tuple([boundedID, sourcePath, content, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()]),
  lspCloseDocument: z.tuple([boundedID, sourcePath]), lspRefresh: z.tuple([boundedID]),
  lspDiagnostics: z.tuple([boundedID, sourcePath.optional()]),
  lspCompletions: z.tuple([boundedID, sourcePath, position, position]),
  lspHover: z.tuple([boundedID, sourcePath, position, position]),
  lspDefinition: z.tuple([boundedID, sourcePath, position, position]),
  lspReferences: z.tuple([boundedID, sourcePath, position, position]),
  lspRenamePreview: z.tuple([boundedID, sourcePath, position, position, z.string().min(1).max(200).refine(value => !!value.trim() && !value.includes('\0'))]),
  debugState: z.tuple([boundedID]), debugSetBreakpoints: z.tuple([boundedID, sourcePath, z.array(position).max(1000)]),
  debugStart: z.tuple([boundedID, debugConfig]), debugStop: z.tuple([boundedID]),
  debugContinue: z.tuple([boundedID]), debugPause: z.tuple([boundedID]),
  debugStepOver: z.tuple([boundedID]), debugStepInto: z.tuple([boundedID]), debugStepOut: z.tuple([boundedID]),
  debugEvaluate: z.tuple([boundedID, question, boundedID.optional()]),
  projects: z.tuple([]), pickProject: z.tuple([]),
  confirmProjectRemoval: z.tuple([boundedID, z.array(sourcePath).min(1).max(10000)]),
  removeProject: z.tuple([id, z.string().uuid().optional()]), entries: z.tuple([id, relative]), read: z.tuple([id, relative]),
  listFiles: z.tuple([id]), sessionUsage: z.tuple([id, id]), agentMap: z.tuple([boundedID, boundedID]),
  save: z.tuple([id, relative, z.string().max(4 * 1024 * 1024), z.string().regex(/^[a-f0-9]{64}$/)]),
  createFile: z.tuple([id, workspacePath, content.optional()]), createDirectory: z.tuple([id, workspacePath]),
  renamePath: z.tuple([id, workspacePath, workspacePath]), deletePath: z.tuple([id, workspacePath]),
  copyPath: z.tuple([id, id, workspacePath, relative]), movePath: z.tuple([id, id, workspacePath, relative]),
  clipboardFiles: z.tuple([]), pasteClipboardFiles: z.tuple([id, relative]),
  revealPath: z.tuple([id, relative.refine(value => !value.includes('\0'))]),
  searchProject: z.tuple([id, searchQuery]), replaceInProject: z.tuple([id, replaceOptions]),
  stageAll: z.tuple([id]), unstageAll: z.tuple([id]), discardFile: z.tuple([id, workspacePath]),
  gitBranches: z.tuple([id]), checkoutBranch: z.tuple([id, branchName]), createBranch: z.tuple([id, branchName, z.boolean().optional()]),
  git: z.tuple([id]), diff: z.tuple([id, relative, diffTargetSchema.optional()]), stage: z.tuple([id, relative, z.boolean(), workspacePath.optional()]), commit: z.tuple([id, z.string().min(1).max(10000).refine(value => !!value.trim() && !value.includes('\0')), commitOptionsSchema.optional()]),
  gitDeleteBranch: z.tuple([id, branchName, z.boolean().optional()]),
  gitFetch: z.tuple([id]), gitPull: z.tuple([id]),
  gitPush: z.tuple([id, z.object({ setUpstream: z.boolean().optional() }).strict().optional()]),
  gitLog: z.tuple([id, z.number().int().min(1).max(200).optional()]),
  gitCommitDetail: z.tuple([id, commitHashSchema]),
  gitUndoLastCommit: z.tuple([id]), gitStashList: z.tuple([id]),
  gitStashPush: z.tuple([id, z.string().max(500).refine(value => !value.includes('\0')).optional(), z.boolean().optional()]),
  gitStashApply: z.tuple([id, z.number().int().min(0).max(10000), z.boolean().optional(), commitHashSchema.optional()]),
  gitStashDrop: z.tuple([id, z.number().int().min(0).max(10000), commitHashSchema.optional()]),
  connection: z.tuple([]), startBackend: z.tuple([]), discover: z.tuple([]), connect: z.tuple([z.string().max(2048), z.string().max(512).optional(), z.string().max(8192).optional()]),
  sessions: z.tuple([id]), createSession: z.tuple([id, z.enum(['default', 'ask', 'readonly', 'full']).optional()]), messages: z.tuple([id, id]), sessionDiff: z.tuple([id, id, id.optional()]), models: z.tuple([id]), agents: z.tuple([id]),
  sessionPermissionMode: z.tuple([id, id]),
  updateSessionPermissionMode: z.tuple([id, id, z.enum(['default', 'ask', 'readonly', 'full'])]),
  renameSession: z.tuple([id, id, sessionTitle]), archiveSession: z.tuple([id, id, z.boolean()]), deleteSession: z.tuple([id, id]),
  commands: z.tuple([id]), skills: z.tuple([id]), generateCommitMessage: z.tuple([id, modelSchema.optional()]),
  buildNotesPreview: z.tuple([id, buildNotesRequestSchema]),
  generateBuildNotes: z.tuple([id, buildNotesRequestSchema]),
  androidTranslationInfo: z.tuple([boundedID]),
  androidTranslationPrompt: z.tuple([boundedID, boundedID.optional(), text.min(1).refine(value => !!value.trim() && !value.includes('\0')), z.enum(['update', 'full', 'scan', 'custom']).optional()]),
  androidTranslationLock: z.tuple([boundedID, boundedID]),
  startCommitAnalysis: z.tuple([boundedID, z.enum(['default', 'ask', 'readonly', 'full']).optional()]),
  pinnedSessionModels: z.tuple([boundedID, boundedID.optional()]),
  prompt: z.tuple([id, id, text, modelSchema.optional(), id.optional(), promptFilesSchema.optional()]),
  resolveDroppedPaths: z.tuple([boundedID, z.array(z.string().max(4096)).max(32)]),
  pickAttachmentFiles: z.tuple([boundedID]),
  cancel: z.tuple([id, id]), permissions: z.tuple([id, id]), replyPermission: z.tuple([id, id, z.enum(['once', 'always', 'reject'])]),
  forms: z.tuple([boundedID, boundedID]), replyForm: z.tuple([boundedID, boundedID, boundedID, formAnswer]),
  cancelForm: z.tuple([boundedID, boundedID, boundedID, z.string().max(2000).refine(value => !value.includes('\0')).optional()]),
  pairingStatus: z.tuple([]), pairingConfigure: z.tuple([pairingSchema]), pairingCode: z.tuple([]),
  pairingRevokeDevice: z.tuple([boundedID]), pairingRevokeAll: z.tuple([]),
  account: z.tuple([z.string().max(64), z.record(z.string(), z.string().max(8192))]), pickImport: z.tuple([]), window: z.tuple([z.enum(['minimize', 'maximize', 'close'])])
} as const
const lspServices = new Map<string, TsLanguageService>()
const debuggers = new Map<string, NodeDebugger>()
function lspFor(projectID: string) {
  const { directory } = workspace.get(projectID)
  let service = lspServices.get(projectID)
  if (!service) { service = createTsLanguageService(directory); lspServices.set(projectID, service) }
  return service
}
function debuggerFor(projectID: string) {
  const { directory } = workspace.get(projectID)
  let service = debuggers.get(projectID)
  if (!service) { service = createNodeDebugger(directory, event => notify({ type: 'debug', projectID, event })); debuggers.set(projectID, service) }
  return service
}
function notify(event: IdeEvent) { if (window && !window.isDestroyed()) window.webContents.send('ame:event', event) }
type TerminalEvent = Extract<IdeEvent, { type: 'terminal' }>
const terminalOutput = new Map<string, { event: TerminalEvent; timer: ReturnType<typeof setTimeout> }>()
function flushTerminalOutput(terminalID?: string) {
  for (const [id, pending] of terminalOutput) {
    if (terminalID !== undefined && id !== terminalID) continue
    clearTimeout(pending.timer)
    terminalOutput.delete(id)
    notify(pending.event)
  }
}
function notifyTerminal(event: IdeEvent) {
  if (event.type !== 'terminal') return notify(event)
  if (event.exitCode !== undefined) { flushTerminalOutput(event.terminalID); notify(event); return }
  const pending = terminalOutput.get(event.terminalID)
  if (pending) { pending.event = { ...event, data: (pending.event.data ?? '') + (event.data ?? '') }; return }
  const timer = setTimeout(() => flushTerminalOutput(event.terminalID), 16)
  terminalOutput.set(event.terminalID, { event: { ...event }, timer })
}
const projectRemovalConfirmations = new Map<string, { token: string; expires: number }>()
async function confirmation(message: string, detail?: string) {
  const result = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Hủy', 'Xác nhận'], defaultId: 0, cancelId: 0, message, ...(detail ? { detail } : {}) })
  if (result.response !== 1) throw new Error('CANCELLED')
}
async function pickImport() {
  const selected = await dialog.showOpenDialog(window!, { title: 'Import AmeKit agents / skills', properties: ['openDirectory'] })
  return selected.canceled ? null : selected.filePaths[0] ?? null
}
let modelPolicyRecovery: Promise<unknown> | undefined
let modelPolicyRecoveryAfter = 0
async function resolveModel(projectID: string, requested?: Model | string, requireRequested = false): Promise<Model> {
  let models = (await adapter.models(projectID)).filter(model => model.providerID === 'amecode')
  let status = await account.call('status', {}) as { account?: { role?: string }; reconnecting?: boolean; models?: { default_model?: string; models?: { id: string }[] } } | null
  if (status?.reconnecting || (!models.length && status?.account)) {
    const refreshed = await account.call('refresh', {}) as typeof status
    if (refreshed) status = refreshed
    models = (await adapter.models(projectID)).filter(model => model.providerID === 'amecode')
  }
  if (!models.length) throw new Error('AMEKIT_MODEL_REQUIRED')
  if (!status?.account) throw new Error('AMECODE_LOGIN_REQUIRED')
  const role = status.account.role, catalog = status.models
  if (!['user', 'admin'].includes(role ?? '') || !catalog?.models?.length || !catalog.default_model) throw new Error('MODEL_POLICY_UNAVAILABLE')
  const allowed = models.filter(model => catalog.models!.some(entry => entry.id === (model.modelID ?? model.id)))
  const requestedID = typeof requested === 'string' ? requested : requested?.id
  // A User's server-fixed canonical model always wins over renderer preferences.
  const selected = role === 'user'
    ? allowed.find(model => (model.modelID ?? model.id) === catalog.default_model)
    : requestedID ? allowed.find(model => model.id === requestedID || (typeof requested === 'string' && model.modelID === requestedID))
      : requireRequested ? undefined : allowed.find(model => (model.modelID ?? model.id) === catalog.default_model) ?? allowed[0]
  if (!selected) throw new Error('AMEKIT_MODEL_REQUIRED')
  await account.call('assert-model', { modelID: selected.modelID ?? selected.id, providerID: selected.providerID })
  if (typeof shuttingDown !== 'undefined' && shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  return selected
}
type FeatureCatalog = { default_model?: string; model_levels?: ModelLevels; active_models?: { id: string; name?: string }[]; models?: { id: string; name?: string }[] }
function resolveCatalogFeatureModel(catalog: FeatureCatalog | undefined, configuredId?: string) {
  if (!configuredId) return undefined
  const id = catalog?.model_levels ? resolveModelLevel({ default_model: catalog.default_model ?? '', model_levels: catalog.model_levels }, configuredId) : configuredId
  return (catalog?.active_models ?? catalog?.models ?? []).find(model => model.id === id)
}
async function resolveFeatureModel(projectID: string, selected: Model, configured?: string): Promise<Model> {
  if (configured && (account.readStatus || /^(?:amecode\/)?(default|haiku|sonnet|opus)$/i.test(configured.trim()))) {
    const status = await (account.readStatus ? account.readStatus() : account.call('status', {})) as { models?: FeatureCatalog } | null
    if (status?.models) configured = resolveCatalogFeatureModel(status.models, configured)?.id
  }
  if (!configured || configured === (selected.modelID ?? selected.id)) return selected
  const authorized = await account.authorizeFeatureModel?.(configured)
  if (shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  if (!authorized) return selected
  const models = await adapter.models(projectID)
  if (shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  return models.find(model => model.providerID === 'amecode' && (model.modelID === authorized || model.id === authorized)) ?? selected
}
async function resolvePinnedModel(projectID: string, pinned: string): Promise<Model> {
  const selected = await resolveModel(projectID)
  if ((selected.modelID ?? selected.id) === pinned) return selected
  const authorized = await account.authorizeFeatureModel?.(pinned)
  if (authorized !== pinned) throw new Error('COMMIT_ANALYSIS_MODEL_UNAVAILABLE')
  const model = (await adapter.models(projectID)).find(model => model.providerID === 'amecode' && (model.modelID ?? model.id) === pinned)
  if (!model) throw new Error('COMMIT_ANALYSIS_MODEL_UNAVAILABLE')
  return model
}
const translationModels = new Map<string, string>()
function translationKey(projectID: string, sessionID: string) { return JSON.stringify([projectID, sessionID]) }
async function resolveTranslationModel(projectID: string, sessionID: string, selected: Model, configuredFeatureModel?: string): Promise<Model> {
  const key = translationKey(projectID, sessionID)
  let pinned = translationModels.get(key)
  if (!pinned) {
    const map = await adapter.agentMap(projectID, sessionID).catch(() => null)
    const session = map?.nodes?.find(node => node.id === sessionID)
    const models = await adapter.models(projectID).catch(() => [])
    const model = models.find(model => model.providerID === 'amecode' && (model.id === session?.model || model.modelID === session?.model))
    pinned = session?.providerID === 'amecode' ? model?.modelID ?? session.model : undefined
  }
  const model = await recoverFeatureSessionModel(projectID, selected, pinned, configuredFeatureModel, 'TRANSLATION_MODEL_UNAVAILABLE')
  translationModels.set(key, model.modelID ?? model.id)
  return model
}
function lockScopes(projectID: string, directory = workspace.get(projectID).directory) {
  return { scope: canonicalWorkspaceScope(directory), legacy: projectID }
}
async function recoverFeatureSessionModel(projectID: string, selected: Model, pinned: string | undefined, configured: string | undefined, unavailable: string): Promise<Model> {
  if (pinned === (selected.modelID ?? selected.id)) return selected
  if (pinned) {
    try {
      const model = await resolveFeatureModel(projectID, selected, pinned)
      if ((model.modelID ?? model.id) === pinned) return model
    } catch { if (shuttingDown) throw new Error('APP_SHUTTING_DOWN') }
  }
  try { return await resolveFeatureModel(projectID, selected, configured) }
  catch {
    if (shuttingDown) throw new Error('APP_SHUTTING_DOWN')
    if (selected.providerID === 'amecode' && (selected.modelID ?? selected.id)) return selected
    throw new Error(unavailable)
  }
}
function assertRegularSession(projectID: string, sessionID: string) {
  const { scope, legacy } = lockScopes(projectID)
  if (translationLocks?.isLocked(scope, sessionID, legacy)) throw new Error('TRANSLATION_SESSION_LOCKED')
  if (translationLocks?.isTranslationSession(scope, sessionID, legacy)) throw new Error('ANDROID_TRANSLATION_SESSION_REQUIRED')
}
async function commitAnalysisFeature(projectID: string): Promise<{ skill: { name: string; instructions: string; directory?: string } | null; model?: string; rawSkillName?: string } | null> {
  return account.readCommitEnhanceFeature
    ? account.readCommitEnhanceFeature(projectID)
    : { skill: (await account.readCommitEnhanceSkill?.(projectID)) ?? null, model: undefined, rawSkillName: undefined }
}
async function commitAnalysisGitStatus(projectID: string) {
  const status = await workspace.status(projectID)
  return {
    branch: status.branch,
    stagedFiles: status.changes.filter(change => !!change.index.trim() && change.index !== '?').map(change => change.path),
    workingFiles: status.changes.filter(change => !!change.working.trim() || change.index === '?').map(change => change.path),
  }
}
function translationLockState(projectID: string): SessionLockState {
  const { scope, legacy } = lockScopes(projectID)
  return {
    translationSessionIDs: translationLocks?.translationSessionIDs(scope, legacy) ?? [],
    lockedSessionIDs: translationLocks?.lockedSessionIDs(scope, legacy) ?? []
  }
}
async function call(method: keyof typeof schema, args: unknown[]) {
  const parsed = schema[method].parse(args) as any[]
  if (typeof shuttingDown !== 'undefined' && shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  // Dispatch remains explicit: renderer never chooses arbitrary Node functions or IPC channels.
  const [a, b, c, d, e, f] = parsed
  if (['commit', 'gitFetch', 'gitPull', 'gitPush', 'terminalCreate', 'debugStart'].includes(method)) await assertWorkspaceTrusted(a)
  switch (method) {
    case 'platform': return process.platform
    case 'artifacts': return adapter.artifacts(a, b)
    case 'artifact': return adapter.artifact(a, b)
    case 'deleteArtifact':
      await confirmation('Xóa artifact này?', 'Hành động này không thể hoàn tác.')
      return adapter.deleteArtifact(a, b)
    case 'btwAsk':
      assertRegularSession(a, b)
      return adapter.btwAsk(a, b, c, await resolveModel(a, d))
    case 'forkSession': return adapter.forkSession(a, b)
    case 'petState': return petHost!.state()
    case 'petSprite': return sprite
    case 'petConfigure': return petHost!.configure(a)
    case 'petSpeech': return petHost!.speech(a)
    case 'petTheme': petHost!.theme(a); return petHost!.state()
    case 'petReport': petHost!.report('main', a); return petHost!.state()
    case 'petTestSpeech': petHost!.testSpeech(); return petHost!.state()
    case 'petGenerateDialogue': {
      const project = workspace.list()[0]
      if (!project) throw new Error('AMEKIT_MODEL_REQUIRED')
      const selected = await resolveModel(project.id, a)
      return petHost!.generate(selected.modelID ?? selected.id)
    }
    case 'terminalProfiles': return terminals.available()
    case 'terminalList': return terminals.list(a)
    case 'terminalCreate': return terminals.create(a, b, c, d)
    case 'terminalSnapshot': flushTerminalOutput(b); return terminals.snapshot(a, b)
    case 'terminalWrite': return terminals.write(a, b, c)
    case 'terminalResize': return terminals.resize(a, b, c, d)
    case 'terminalClose': flushTerminalOutput(b); return terminals.close(a, b)
    case 'lspUpdateDocument': return lspFor(a).updateDocument(b, c, d)
    case 'lspCloseDocument': return lspFor(a).closeDocument(b)
    case 'lspRefresh': return lspFor(a).refreshFiles()
    case 'lspDiagnostics': return lspFor(a).diagnostics(b)
    case 'lspCompletions': return lspFor(a).completions(b, c, d)
    case 'lspHover': return lspFor(a).hover(b, c, d)
    case 'lspDefinition': return lspFor(a).definition(b, c, d)
    case 'lspReferences': return lspFor(a).references(b, c, d)
    case 'lspRenamePreview': return lspFor(a).renamePreview(b, c, d, e)
    case 'debugState': return debuggerFor(a).state()
    case 'debugSetBreakpoints': return debuggerFor(a).setBreakpoints(b, c)
    case 'debugStart': return debuggerFor(a).start(b)
    case 'debugStop': return debuggerFor(a).stop()
    case 'debugContinue': return debuggerFor(a).continue()
    case 'debugPause': return debuggerFor(a).pause()
    case 'debugStepOver': return debuggerFor(a).stepOver()
    case 'debugStepInto': return debuggerFor(a).stepInto()
    case 'debugStepOut': return debuggerFor(a).stepOut()
    case 'debugEvaluate': return debuggerFor(a).evaluate(b, c)
    case 'projects': return workspace.list()
    case 'pickProject': {
      const result = await dialog.showOpenDialog(window!, { title: 'Mở project', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return null
      const project = await workspace.add(result.filePaths[0]); adapter.attach(project.id, project.directory); return project
    }
    case 'confirmProjectRemoval': {
      const project = workspace.get(a)
      projectRemovalConfirmations.delete(a)
      const { response } = await dialog.showMessageBox(window!, {
        type: 'warning', buttons: ['Hủy', 'Lưu và gỡ', 'Bỏ thay đổi và gỡ'], defaultId: 0, cancelId: 0,
        message: `Gỡ dự án ${project.name} có ${b.length} tệp chưa lưu?`,
        detail: `Tệp trên ổ đĩa sẽ KHÔNG bị xóa. Chọn bỏ thay đổi sẽ mất các chỉnh sửa chưa lưu.\n\n${b.join('\n')}`,
      })
      if (response !== 1 && response !== 2) return null
      const token = randomUUID()
      projectRemovalConfirmations.set(a, { token, expires: Date.now() + 5 * 60_000 })
      return { choice: response === 1 ? 'save' : 'discard', token }
    }
    case 'removeProject': {
      const project = workspace.get(a)
      const approved = projectRemovalConfirmations.get(a)
      projectRemovalConfirmations.delete(a)
      if (b !== undefined) {
        if (!approved || approved.token !== b || approved.expires < Date.now()) throw new Error('CANCELLED: Xác nhận gỡ dự án đã hết hiệu lực.')
      } else await confirmation(`Gỡ dự án ${project.name} khỏi danh sách? Tệp trên ổ đĩa sẽ KHÔNG bị xóa.`)
      // Migrate legacy IDs before forgetting their association with this directory.
      if (project.directory && (typeof translationLocks !== 'undefined' && translationLocks)) {
        const { scope, legacy } = lockScopes(a, project.directory)
        for (const sessionID of translationLocks?.translationSessionIDs(scope, legacy) ?? []) await translationLocks!.recordSession(scope, sessionID, legacy)
        for (const sessionID of translationLocks?.lockedSessionIDs(scope, legacy) ?? []) await translationLocks!.lockSession(scope, sessionID, legacy)
      }
      await workspace.remove(a)
      terminals.closeProject(a)
      try { lspServices.get(a)?.dispose() }
      finally {
        lspServices.delete(a)
        try { await debuggers.get(a)?.dispose() }
        finally { debuggers.delete(a); adapter.detach(a) }
      }
      return
    }
    case 'entries': return workspace.entries(a, b)
    case 'listFiles': return workspace.listFiles(a)
    case 'read': return workspace.read(a, b)
    case 'save': return workspace.save(a, b, c, d)
    case 'git': return workspace.status(a)
    case 'diff': return workspace.diff(a, b, c)
    case 'createFile': return workspace.createFile(a, b, c)
    case 'createDirectory': return workspace.createDirectory(a, b)
    case 'renamePath': return workspace.renamePath(a, b, c)
    case 'copyPath': return workspace.copyPath(a, b, c, d)
    case 'movePath': return workspace.movePath(a, b, c, d)
    case 'clipboardFiles': {
      const files = await osClipboardFiles()
      return { hasFiles: files.length > 0, count: files.length, names: files.map(file => path.basename(file)) }
    }
    case 'pasteClipboardFiles': {
      const files = await osClipboardFiles()
      if (!files.length) throw Object.assign(new Error('CLIPBOARD_EMPTY'), { code: 'CLIPBOARD_EMPTY' })
      return workspace.pasteExternalPaths(a, files, b)
    }
    case 'deletePath':
      await confirmation(`Xóa ${b} khỏi ổ đĩa? Hành động này không thể hoàn tác.`)
      return workspace.deletePath(a, b)
    case 'revealPath': {
      const { target } = await validateWorkspacePath(workspace.get(a).directory, b, { allowRoot: true })
      shell.showItemInFolder(target)
      return
    }
    case 'openExternal': return shell.openExternal(new URL(a).href)
    case 'searchProject': return workspace.searchProject(a, b)
    case 'replaceInProject': {
      if (b.dryRun === true) return workspace.replaceInProject(a, b)
      const preview = await workspace.replaceInProject(a, { ...b, dryRun: true })
      if (preview.replacements === 0) return preview
      await confirmation(`Thay thế ${preview.replacements} vị trí trong ${preview.filesChanged} tệp?`)
      return workspace.replaceInProject(a, b, preview.previews)
    }
    case 'stageAll': return workspace.stageAll(a)
    case 'unstageAll': return workspace.unstageAll(a)
    case 'discardFile':
      await confirmation(`Hủy mọi thay đổi chưa lưu trong ${b}? Hành động này không thể hoàn tác.`)
      return workspace.discardFile(a, b)
    case 'gitBranches': return workspace.gitBranches(a)
    case 'checkoutBranch': return workspace.checkoutBranch(a, b)
    case 'createBranch': return workspace.createBranch(a, b, c)
    case 'stage': return workspace.stage(a, b, c, d)
    case 'commit': return workspace.commit(a, b, c)
    case 'gitDeleteBranch':
      await confirmation(`Xóa nhánh ${b}?`)
      return workspace.gitDeleteBranch(a, b, c)
    case 'gitFetch': return workspace.gitFetch(a)
    case 'gitPull': return workspace.gitPull(a)
    case 'gitPush': return workspace.gitPush(a, b)
    case 'gitLog': return workspace.gitLog(a, b)
    case 'gitCommitDetail': return workspace.gitCommitDetail(a, b)
    case 'gitUndoLastCommit': {
      const pushed = await isHeadPushed(workspace.get(a).directory)
      await confirmation('Hoàn tác commit cuối cùng?', pushed ? 'Cảnh báo: HEAD đã được push lên remote. Hoàn tác sẽ thay đổi lịch sử cục bộ đã chia sẻ.' : 'Commit chưa được push lên remote. Thay đổi sẽ được giữ trong staging area.')
      return workspace.gitUndoLastCommit(a)
    }
    case 'gitStashList': return workspace.gitStashList(a)
    case 'gitStashPush': return workspace.gitStashPush(a, b, c)
    case 'gitStashApply': return d === undefined ? workspace.gitStashApply(a, b, c) : workspace.gitStashApply(a, b, c, d)
    case 'gitStashDrop':
      await confirmation(`Xóa stash@{${b}}? Hành động này không thể hoàn tác.`)
      return c === undefined ? workspace.gitStashDrop(a, b) : workspace.gitStashDrop(a, b, c)
    case 'connection': return adapter.connection()
    case 'startBackend': return startBackend()
    case 'connect':
      await configurePairing({ ...pairing.status(), enabled: false })
      if (adapter.connection().url) await account.call('logout', {})
      await adapter.connect(a, b, c); managed = false
      return adapter.connection()
    case 'discover':
      await configurePairing({ ...pairing.status(), enabled: false })
      if (adapter.connection().url) await account.call('logout', {})
      await adapter.discover(); managed = false
      return adapter.connection()
    case 'pairingStatus': return pairing.status()
    case 'pairingConfigure':
      if (a.enabled && !managed) throw new Error('PAIRING_PRIVATE_BACKEND_REQUIRED')
      // Consent is request-bound: queued disable/enable transitions can change status while the dialog is open.
      if (a.enabled) await confirmation('Bật Remote access qua OpenTunnel? Máy chủ sẽ có địa chỉ Internet; lưu lượng được mã hóa đầu cuối tại Ame IDE. Thiết bị có mã QR hoặc link sẽ có toàn quyền OpenCode tích hợp. Không chia sẻ mã ghép nối.')
      return withAuthority(() => {
        if (a.enabled && !managed) throw new Error('PAIRING_PRIVATE_BACKEND_REQUIRED')
        return configurePairing(a)
      })
    case 'pairingCode': return pairing.issue()
    case 'pairingRevokeDevice':
      await confirmation('Ngắt kết nối thiết bị này? Thiết bị sẽ không thể truy cập Ame IDE cho tới khi ghép nối lại.')
      return withAuthority(() => pairing.revokeDevice(a))
    case 'pairingRevokeAll':
      await confirmation('Ngắt kết nối tất cả thiết bị đã ghép nối? Mọi thiết bị từ xa sẽ mất quyền truy cập ngay lập tức.')
      return withAuthority(() => pairing.revokeAll())
    case 'sessions': return adapter.sessions(a)
    case 'createSession': {
      const orchestrator = await account.readOrchestrator?.()
      return orchestrator ? adapter.createSession(a, b, orchestrator.id) : adapter.createSession(a, b)
    }
    case 'sessionPermissionMode': return adapter.sessionPermissionMode(a, b)
    case 'updateSessionPermissionMode':
      await assertRegularSession(a, b)
      return adapter.updateSessionPermissionMode(a, b, c)
    case 'renameSession': return adapter.renameSession(a, b, c)
    case 'archiveSession': return adapter.archiveSession(a, b, c)
    case 'deleteSession':
      await confirmation('Xóa cuộc trò chuyện này? Hành động này không thể hoàn tác.')
      return adapter.deleteSession(a, b)
    case 'commands': return adapter.commands(a)
    case 'skills': return adapter.skills(a)
    case 'generateCommitMessage': {
      const selected = await resolveModel(a, b)
      const summary = await workspace.stagedDiffSummary(a, 24576)
      if (summary.files.length === 0) throw new Error('NO_STAGED_CHANGES')
      const feature = account.readCommitEnhanceFeature
        ? await account.readCommitEnhanceFeature(a).catch(() => null)
        : { skill: (await account.readCommitEnhanceSkill?.(a).catch(() => null)) ?? null, model: undefined }
      const model = await resolveFeatureModel(a, selected, feature?.model)
      const skill = feature?.skill ? { name: feature.skill.name, instructions: feature.skill.instructions } : null
      const input = summary.truncated && summary.stat
        ? { ...summary, diff: `[Diff bị cắt ở 24576 bytes — tóm tắt toàn bộ tệp đã stage]\n${summary.stat}\n\n${summary.diff}` }
        : summary
      return skill ? adapter.generateCommitMessage(input, model, skill) : adapter.generateCommitMessage(input, model)
    }
    case 'buildNotesPreview': {
      const [summary, feature, status] = await Promise.all([
        workspace.buildNotesSummary(a, b, 56_000),
        account.readBuildNotesFeature?.(a).catch(() => null),
        (account.readStatus ? account.readStatus() : account.call('status', {})).catch(() => null),
      ])
      const catalog = (status as { models?: FeatureCatalog } | null)?.models
      const configured = resolveCatalogFeatureModel(catalog, feature?.model)
      const effective = configured ?? resolveCatalogFeatureModel(catalog, catalog?.default_model)
      const skillName = feature?.skill?.name ?? feature?.rawSkillName
      return {
        branch: summary.branch,
        commitCount: summary.commits.length,
        commits: summary.commits,
        files: summary.files,
        workingFileCount: summary.workingFileCount,
        additions: summary.additions,
        deletions: summary.deletions,
        truncated: summary.truncated,
        ...(skillName ? { skill: skillName } : {}),
        ...(feature?.model ? { configuredModelID: feature.model } : {}),
        ...(effective?.id ? { effectiveModelID: effective.id } : {}),
        fallbackToDefault: !configured,
      } satisfies BuildNotesPreview
    }
    case 'generateBuildNotes': {
      const selected = await resolveModel(a)
      const summary = await workspace.buildNotesSummary(a, b, 56_000)
      if (summary.commits.length === 0 && summary.files.length === 0) throw new Error('NO_BUILD_CHANGES')
      const feature = await account.readBuildNotesFeature?.(a).catch(() => null)
      const model = await resolveFeatureModel(a, selected, feature?.model)
      const skill = feature?.skill ? { name: feature.skill.name, instructions: feature.skill.instructions } : undefined
      const generated = await adapter.generateBuildNotes(summary, model, skill, b.note?.trim() || undefined)
      return {
        notes: generated.notes,
        truncated: generated.truncated,
        commitCount: summary.commits.length,
        fileCount: summary.files.length,
        workingFileCount: summary.workingFileCount,
        modelID: model.modelID ?? model.id,
        ...(skill ? { skill: skill.name } : {}),
      } satisfies BuildNotesResult
    }
    case 'pinnedSessionModels': {
      const models = pinnedModels?.models(lockScopes(a).scope) ?? {}
      // Restore the feature entitlement before the renderer reloads its catalog.
      // Only recover the selected session: an unavailable pin in another chat
      // must not prevent this chat from opening.
      if (b && models[b]) await withAuthority(() => resolvePinnedModel(a, models[b]))
      return models
    }
    case 'startCommitAnalysis': {
      if (!pinnedModels) throw new Error('PINNED_MODEL_STORE_UNAVAILABLE')
      const feature = await commitAnalysisFeature(a)
      const status = await (account.readStatus ? account.readStatus() : account.call('status', {})) as { models?: FeatureCatalog } | null
      const target = resolveCatalogFeatureModel(status?.models, feature?.model || status?.models?.default_model)
      if (!target) throw new Error('COMMIT_ANALYSIS_MODEL_UNAVAILABLE')
      const model = await resolvePinnedModel(a, target.id)
      const git = await commitAnalysisGitStatus(a)
      const orchestrator = await account.readOrchestrator?.()
      const session = await adapter.createSession(a, b, orchestrator?.id)
      await pinnedModels.pin(lockScopes(a).scope, session.id, model.modelID ?? model.id)
      let nativeSkills: { id: string }[] | undefined
      if (feature?.skill) {
        const matched = (await adapter.skills(a).catch(() => [])).find(skill => skill.name === feature.skill!.name || skill.id === feature.skill!.name)
        if (matched) nativeSkills = [{ id: matched.id }]
      }
      await adapter.prompt(a, session.id, buildCommitAnalysisPrompt({ ...git, skill: feature?.skill }), model, undefined, undefined, nativeSkills)
      return { session, model }
    }
    case 'androidTranslationInfo': {
      const { directory } = workspace.get(a)
      const [detected, feature, status] = await Promise.all([
        detectAndroidProject(directory),
        account.readAndroidTranslationFeature?.(a).catch(() => null),
        (account.readStatus ? account.readStatus() : account.call('status', {})).catch(() => null)
      ])
      const catalog = (status as { models?: FeatureCatalog } | null)?.models
      const configured = resolveCatalogFeatureModel(catalog, feature?.model)
      const fallback = configured ?? resolveCatalogFeatureModel(catalog, catalog?.default_model)
      const runtime = !fallback ? (await adapter.models(a).catch(() => [])).find(model => model.providerID === 'amecode') : undefined
      const effective = fallback ?? (runtime ? { id: runtime.modelID ?? runtime.id, name: runtime.name } : undefined)
      return {
        configured: !!(feature?.rawSkillName || feature?.skill), isAndroid: detected.isAndroid,
        skill: feature?.skill?.name ?? feature?.rawSkillName, configuredModelID: feature?.model,
        effectiveModelID: effective?.id, effectiveModelName: effective?.name ?? effective?.id,
        fallbackToDefault: !configured, stringsFiles: detected.stringsFiles, ...translationLockState(a)
      } satisfies AndroidTranslationInfo
    }
    case 'androidTranslationPrompt': {
      const { directory } = workspace.get(a)
      const { scope, legacy } = lockScopes(a)
      if (!translationLocks) throw new Error('TRANSLATION_LOCK_STORE_UNAVAILABLE')
      if (b && translationLocks.isLocked(scope, b, legacy)) throw new Error('TRANSLATION_SESSION_LOCKED')
      if (b && !translationLocks.isTranslationSession(scope, b, legacy)) throw new Error('ANDROID_TRANSLATION_SESSION_REQUIRED')
      const feature = await account.readAndroidTranslationFeature?.(a)
      if (!feature?.skill) throw new Error('ANDROID_TRANSLATION_NOT_CONFIGURED')
      const selected = await resolveModel(a).catch(error => {
        if (b && error instanceof Error && error.message === 'AMEKIT_MODEL_REQUIRED') throw new Error('TRANSLATION_MODEL_UNAVAILABLE')
        throw error
      })
      const model = b ? await resolveTranslationModel(a, b, selected, feature.model) : await resolveFeatureModel(a, selected, feature.model)
      const detected = await detectAndroidProject(directory)
      const session = b ? (await adapter.sessions(a)).find(session => session.id === b) : await adapter.createSession(a)
      if (!session) throw new Error('SESSION_NOT_FOUND')
      const isFirstTurn = !b || (await adapter.messages(a, b)).length === 0
      await translationLocks.recordSession(scope, session.id, legacy)
      translationModels.set(translationKey(a, session.id), model.modelID ?? model.id)
      const prompt = buildAndroidTranslationPrompt({
        userText: d && d !== 'custom' ? `[Translation mode: ${d}]\n${c}` : c,
        isFirstTurn, skill: feature.skill, stringsFiles: detected.stringsFiles
      })
      let skills: { id: string }[] | undefined
      if (isFirstTurn) {
        const skillName = feature.skill.name
        try {
          const matched = (await adapter.skills(a)).find(skill => skill.name === skillName || skill.id === skillName)
          if (matched) skills = [{ id: matched.id }]
        } catch { /* Native skills may be unavailable; retain the scoped text prompt. */ }
      }
      if (skills) await adapter.prompt(a, session.id, prompt, model, undefined, undefined, skills)
      else await adapter.prompt(a, session.id, prompt, model)
      return { session, model, locked: false } satisfies AndroidTranslationPromptResult
    }
    case 'androidTranslationLock': {
      const { scope, legacy } = lockScopes(a)
      if (!translationLocks?.isTranslationSession(scope, b, legacy)) throw new Error('ANDROID_TRANSLATION_SESSION_REQUIRED')
      await translationLocks.lockSession(scope, b, legacy)
      // prompt() acknowledges submission, not model completion; interrupt any remaining turn.
      try { await adapter.cancel(a, b) }
      finally { notify({ type: 'opencode', projectID: a, sessionID: b }) }
      return translationLockState(a)
    }
    case 'messages': return adapter.messages(a, b)
    case 'agentMap': return adapter.agentMap(a, b)
    case 'sessionDiff': return adapter.sessionDiff(a, b, c)
    case 'stageRevert': assertRegularSession(a, b); return adapter.stageRevert(a, b, c, d)
    case 'clearRevert': assertRegularSession(a, b); return adapter.clearRevert(a, b)
    case 'sessionUsage': {
      const pricing = await (account.readUsagePrices ? account.readUsagePrices() : account.call('usage-prices', {})).catch(() => ({ origin: null, prices: {} })) as { origin: string | null; prices: UsagePrices }
      return adapter.sessionUsage(a, b, pricing.prices, pricing.origin)
    }
    case 'models': {
      const models = await adapter.models(a)
      if (models.some(model => model.providerID === 'amecode')) return models
      try {
        const status = await (account.readStatus ? account.readStatus() : account.call('status', {})) as { account?: unknown; reconnecting?: boolean; models?: { models?: unknown[] } } | null
        if (!(status?.reconnecting || (status?.account && status.models?.models?.length))) return models
        // Share recovery across locations and start cooldown after the attempt settles.
        if (!modelPolicyRecovery && Date.now() >= modelPolicyRecoveryAfter) {
          modelPolicyRecovery = withAuthority(() => account.call('refresh', {})).finally(() => {
            modelPolicyRecoveryAfter = Date.now() + 15_000
            modelPolicyRecovery = undefined
          })
        }
        if (modelPolicyRecovery) await modelPolicyRecovery
        // Another caller may have finished recovery while this status read was pending.
        return await adapter.models(a)
      } catch {
        // Keep model discovery usable during account/network outages; allow a later retry.
        return models
      }
    }
    case 'agents': return adapter.agents(a)
    case 'resolveDroppedPaths': return resolveDroppedPaths(workspace.get(a).directory, b)
    case 'pickAttachmentFiles': {
      const directory = workspace.get(a).directory
      const picked = await dialog.showOpenDialog(window!, {
        title: 'Chọn tệp hoặc ảnh để đính kèm',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Ảnh, PDF & Tệp mã/văn bản', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'mdx', 'json', 'yaml', 'yml', 'xml', 'ts', 'tsx', 'js', 'jsx', 'kt', 'java', 'py', 'css', 'html', 'log', 'csv'] },
          { name: 'Tất cả tệp', extensions: ['*'] },
        ],
      })
      return picked.canceled || !picked.filePaths.length ? [] : resolveDroppedPaths(directory, picked.filePaths)
    }
    case 'prompt': {
      assertRegularSession(a, b)
      await validatePromptFiles(a, f)
      const pinned = pinnedModels?.models(lockScopes(a).scope)[b]
      const selected = pinned ? await resolvePinnedModel(a, pinned) : await resolveModel(a, d, true)
      return adapter.prompt(a, b, c, selected, e, f)
    }
    case 'cancel': return adapter.cancel(a, b)
    case 'permissions': return adapter.permissions(a, b)
    case 'forms': return adapter.forms(a, b)
    case 'replyForm': return adapter.replyForm(a, b, c, d)
    case 'cancelForm': return adapter.cancelForm(a, b, c, d)
    case 'replyPermission': return adapter.replyPermission(a, b, c)
    case 'account': return account.call(a, b)
    case 'pickImport': return pickImport()
    case 'window':
      if (a === 'close') window?.close()
      else if (a === 'minimize') window?.minimize()
      else if (window?.isMaximized()) window.unmaximize()
      else window?.maximize()
      return
  }
}
let authority: Promise<unknown> = Promise.resolve()
function withAuthority<T>(operation: () => Promise<T>) {
  const task = authority.catch(() => {}).then(() => {
    if (shuttingDown) throw new Error('APP_SHUTTING_DOWN')
    return operation()
  })
  authority = task
  return task
}
function dispatch(method: keyof typeof schema, args: unknown[]) {
  if (!['startBackend', 'connect', 'discover', 'createSession', 'prompt', 'stageRevert', 'clearRevert', 'generateCommitMessage', 'generateBuildNotes', 'androidTranslationPrompt', 'androidTranslationLock', 'startCommitAnalysis', 'btwAsk', 'petGenerateDialogue', 'account'].includes(method)) return call(method, args)
  // Fresh policy checks and model requests cannot straddle an endpoint switch.
  const task = authority.catch(() => {}).then(() => call(method, args))
  authority = task
  return task
}
async function openWindow() {
  window = new BrowserWindow({ width: 1536, height: 960, minWidth: 1000, minHeight: 640, title: 'Ame IDE', backgroundColor: '#16181d',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } } : { frame: false }),
    webPreferences: { preload: path.join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (target !== window?.webContents.getURL()) event.preventDefault()
  })
  window.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(window!, { type: 'warning', buttons: ['Ở lại', 'Bỏ thay đổi và đóng'], defaultId: 0, cancelId: 0, message: 'Có file chưa lưu. Đóng Ame IDE?' })
    if (response === 1) event.preventDefault()
  })
  window.webContents.on('render-process-gone', () => { flushTerminalOutput(); terminals.dispose(); flushTerminalOutput() })
  window.on('closed', () => { flushTerminalOutput(); terminals.dispose(); flushTerminalOutput(); window = undefined; petHost?.reconcile() })
  if (renderer.url) await window.loadURL(renderer.url)
  else await window.loadFile(renderer.file!)
  petHost?.reconcile()
}
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
void app.whenReady().then(async () => {
  if (!primaryInstance) return
  session?.defaultSession?.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false))
  session?.defaultSession?.setPermissionCheckHandler?.(() => false)
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]))
  workspace = new Workspaces(path.join(app.getPath('userData'), 'projects.json'), projectID => {
    void lspServices.get(projectID)?.refreshFiles().catch(() => {})
    notify({ type: 'files', projectID })
  })
  await workspace.load()
  await loadWorkspaceTrust()
  translationLocks = createTranslationLockStore(path.join(app.getPath('userData'), 'translation-locks.json'))
  await translationLocks.load()
  pinnedModels = createPinnedSessionModelStore(path.join(app.getPath('userData'), 'pinned-session-models.json'))
  await pinnedModels.load()
  terminals = new Terminals(projectID => workspace.get(projectID).directory, notifyTerminal)
  adapter = new OpenCodeAdapter(notify)
  for (const project of workspace.list()) adapter.attach(project.id, project.directory)
  const spritePath = app.isPackaged ? path.join(process.resourcesPath, 'ame-chibi.png') : path.join(app.getAppPath(), 'packages/amekit/src/assets/ame-chibi.png')
  sprite = await loadPetSprite(spritePath).catch(() => '')
  petHost = createPetHost({ userData: app.getPath('userData'), electron: { BrowserWindow, screen }, sprite, defaultEnabled: true,
    interactionPreload: path.join(here, '../preload/pet.cjs'), onActivate: () => revealPetMainWindow(window),
    hasMainWindow: () => Boolean(window && !window.isDestroyed()), onStateChanged: state => notify({ type: 'pet', state }),
    generateDialogue: (model, signal) => account.generatePetDialogue(model, signal) })
  runtime = new PrivateRuntime({ resources: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), profile: path.join(app.getPath('userData'), 'backend'), onExit: () => {
    if (managed && !shuttingDown) { void pairing?.stop(); adapter.disconnected('OpenCode tích hợp đã dừng. Mở Cài đặt để thử lại.') }
  } })
  const pairingDir = path.join(app.getPath('userData'), 'remote-access')
  const deviceStore = new PairingDeviceStore(path.join(pairingDir, 'devices.json'))
  await deviceStore.ready()
  pairing = new RemotePairing(new PairingHost(() => managed ? adapter.endpoint() : undefined, deviceStore), automaticTunnel(pairingDir))
  account = createAmeKit({
    userData: app.getPath('userData'),
    globalConfigDir: path.join(app.getPath('userData'), 'backend', 'config', 'opencode'),
    autoSync: true,
    reloadRuntime: async () => { if (managed && !shuttingDown) await adapter.reload().catch(() => {}) },
    onBundleChanged: event => {
      const timer = setTimeout(() => { if (!shuttingDown) notify({ type: 'amekit-bundle', ...event, projectID: '' }) }, 500)
      timer.unref?.()
    },
    endpoint: () => adapter.endpoint(),
    project: async projectID => workspace.get(projectID).directory,
    pickImport,
    cli: runtime.executable()
  })
  await petHost.init()
  ipcMain.handle('ame:call', async (event, method: unknown, args: unknown) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isRendererDocument(event.senderFrame.url, renderer)) throw new Error('UNTRUSTED_CALLER')
    if (typeof method !== 'string' || !Object.hasOwn(schema, method) || !Array.isArray(args)) throw new Error('INVALID_REQUEST')
    try { return await dispatch(method as keyof typeof schema, args) }
    catch (error) {
      const message = error instanceof Error ? error.message : 'OPERATION_FAILED'
      // Account errors are codes; do not serialize HTTP headers or request objects.
      throw new Error(message.slice(0, 1200))
    }
  })
  await openWindow()
  authority = dispatch('startBackend', []).then(async () => {
    try {
      const saved = JSON.parse(await readFile(path.join(app.getPath('userData'), 'pairing.json'), 'utf8'))
      const settings = pairingSchema.parse(saved)
      // Migrating a manual tunnel does not imply consent to provisioning a new public route.
      if ('publicURL' in saved) settings.enabled = false
      if (!shuttingDown) await configurePairing(settings)
    } catch { /* Pairing remains off when settings are absent or invalid. */ }
  })
  app.on('activate', () => { if (!window) void openWindow() })
}).catch(error => { dialog.showErrorBox('Ame IDE không thể khởi động', error instanceof Error ? error.message : 'STARTUP_FAILED'); app.quit() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
let quitting = false
app.on('will-quit', event => {
  flushTerminalOutput()
  if (quitting || !account) return
  event.preventDefault(); quitting = true; shuttingDown = true
  screenActive(false)
  terminals?.dispose()
  flushTerminalOutput()
  adapter.abortRequests()
  // Start Account disposal now: its abort signal releases work holding authority.
  const accountDisposal = account.dispose().catch(() => {})
  // Abort in-flight pet generation before waiting for authority; queued calls fail closed.
  let deadline: ReturnType<typeof setTimeout>
  const cleanup = Promise.resolve().then(() => petHost?.dispose()).finally(async () => {
    for (const service of lspServices.values()) { try { service.dispose() } catch { /* Continue disposing other projects. */ } }
    lspServices.clear()
    await Promise.allSettled([...debuggers.values()].map(async service => service.dispose()))
    debuggers.clear()
  }).finally(() => authority.catch(() => {}))
    .finally(() => pairing.stop()).finally(() => accountDisposal)
    .finally(() => adapter.dispose()).finally(() => workspace.dispose()).finally(() => runtime.stop())
  void Promise.race([cleanup, new Promise<void>(resolve => { deadline = setTimeout(resolve, 8_000) })])
    .catch(() => {}).finally(() => { clearTimeout(deadline); app.quit() })
})
