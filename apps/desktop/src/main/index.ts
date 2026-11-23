import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, screen, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { PairingHost } from '../../../../packages/opencode-adapter/src/pairing'
import { RemotePairing, automaticTunnel } from '../../../../packages/opencode-adapter/src/remote-pairing'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Workspaces } from '../../../../packages/ide-core/src/workspace'
import { validateWorkspacePath } from '../../../../packages/ide-core/src/workspace-fs'
import { resolveDroppedPaths } from '../../../../packages/ide-core/src/dropped-attachments'
import { Terminals } from '../../../../packages/ide-core/src/terminal'
import { createTsLanguageService, type TsLanguageService } from '../../../../packages/ide-core/src/ts-lsp'
import { createNodeDebugger, type NodeDebugger } from '../../../../packages/ide-core/src/debugger'
import { OpenCodeAdapter } from '../../../../packages/opencode-adapter/src/index'
import { PrivateRuntime } from '../../../../packages/opencode-adapter/src/runtime'
import { createAmeKit } from '../../../../packages/amekit/src/index'
import { detectAndroidProject, buildAndroidTranslationPrompt, createTranslationLockStore } from '../../../../packages/amekit/src/android-translation'
import { createPetHost } from '../../../../packages/amekit/src/pet-host'
import { loadPetSprite } from '../../../../packages/amekit/src/pet'
import type { UsagePrices } from '../../../../packages/amekit/src/usage-pricing'
import type { AndroidTranslationInfo, AndroidTranslationPromptResult, IdeEvent, Model, SessionLockState } from '../../../../packages/protocol/src/index'

if (!app.isPackaged && process.env.AME_IDE_TEST_DATA) app.setPath('userData', path.resolve(process.env.AME_IDE_TEST_DATA))
const here = path.dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | undefined
let workspace: Workspaces
let terminals: Terminals
let adapter: OpenCodeAdapter
let account: ReturnType<typeof createAmeKit>
let translationLocks: ReturnType<typeof createTranslationLockStore> | undefined
let petHost: ReturnType<typeof createPetHost> | undefined
let sprite = ''
let runtime: PrivateRuntime
let managed = true
let shuttingDown = false
let pairing: RemotePairing
let screenBlocker: number | undefined
const pairingSchema = z.object({ enabled: z.boolean(), keepScreenActive: z.boolean() })
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
const id = z.string().min(1).max(512)
const relative = z.string().max(4096)
const workspacePath = relative.min(1).refine(value => !value.includes('\0'))
const branchName = z.string().min(1).max(512).refine(value => !value.includes('\0'))
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
  maxMatches: z.number().int().min(1).max(100000).optional()
}).strict()
const replaceOptions = searchQuery.extend({
  replacement: z.string().max(200000), files: z.array(workspacePath).max(5000).optional(), dryRun: z.boolean().optional()
}).strict()
const schema = {
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
  projects: z.tuple([]), pickProject: z.tuple([]), removeProject: z.tuple([id]), entries: z.tuple([id, relative]), read: z.tuple([id, relative]),
  listFiles: z.tuple([id]), sessionUsage: z.tuple([id, id]), agentMap: z.tuple([boundedID, boundedID]),
  save: z.tuple([id, relative, z.string().max(4 * 1024 * 1024), z.string().regex(/^[a-f0-9]{64}$/)]),
  createFile: z.tuple([id, workspacePath, content.optional()]), createDirectory: z.tuple([id, workspacePath]),
  renamePath: z.tuple([id, workspacePath, workspacePath]), deletePath: z.tuple([id, workspacePath]),
  revealPath: z.tuple([id, relative.refine(value => !value.includes('\0'))]),
  searchProject: z.tuple([id, searchQuery]), replaceInProject: z.tuple([id, replaceOptions]),
  stageAll: z.tuple([id]), unstageAll: z.tuple([id]), discardFile: z.tuple([id, workspacePath]),
  gitBranches: z.tuple([id]), checkoutBranch: z.tuple([id, branchName]), createBranch: z.tuple([id, branchName, z.boolean().optional()]),
  git: z.tuple([id]), diff: z.tuple([id, relative]), stage: z.tuple([id, relative, z.boolean()]), commit: z.tuple([id, z.string().min(1).max(10000)]),
  connection: z.tuple([]), startBackend: z.tuple([]), discover: z.tuple([]), connect: z.tuple([z.string().max(2048), z.string().max(512).optional(), z.string().max(8192).optional()]),
  sessions: z.tuple([id]), createSession: z.tuple([id]), messages: z.tuple([id, id]), sessionDiff: z.tuple([id, id, id.optional()]), models: z.tuple([id]), agents: z.tuple([id]),
  renameSession: z.tuple([id, id, sessionTitle]), archiveSession: z.tuple([id, id, z.boolean()]), deleteSession: z.tuple([id, id]),
  commands: z.tuple([id]), skills: z.tuple([id]), generateCommitMessage: z.tuple([id, modelSchema.optional()]),
  androidTranslationInfo: z.tuple([boundedID]),
  androidTranslationPrompt: z.tuple([boundedID, boundedID.optional(), text.min(1).refine(value => !!value.trim() && !value.includes('\0')), z.enum(['update', 'full', 'scan', 'custom']).optional()]),
  androidTranslationLock: z.tuple([boundedID, boundedID]),
  prompt: z.tuple([id, id, text, z.object({ id, modelID: id.optional(), name: z.string().max(512), providerID: id }).optional(), id.optional(), promptFilesSchema.optional()]),
  resolveDroppedPaths: z.tuple([boundedID, z.array(z.string().max(4096)).max(32)]),
  pickAttachmentFiles: z.tuple([boundedID]),
  cancel: z.tuple([id, id]), permissions: z.tuple([id, id]), replyPermission: z.tuple([id, id, z.enum(['once', 'always', 'reject'])]),
  pairingStatus: z.tuple([]), pairingConfigure: z.tuple([pairingSchema]), pairingCode: z.tuple([]),
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
async function confirmation(message: string, detail?: string) {
  const result = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Hủy', 'Xác nhận'], defaultId: 0, cancelId: 0, message, ...(detail ? { detail } : {}) })
  if (result.response !== 1) throw new Error('CANCELLED')
}
async function pickImport() {
  const selected = await dialog.showOpenDialog(window!, { title: 'Import AmeKit agents / skills', properties: ['openDirectory'] })
  return selected.canceled ? null : selected.filePaths[0] ?? null
}
async function resolveModel(projectID: string, requested?: Model | string, requireRequested = false): Promise<Model> {
  const models = (await adapter.models(projectID)).filter(model => model.providerID === 'amecode')
  if (!models.length) throw new Error('AMEKIT_MODEL_REQUIRED')
  const status = await account.call('status', {}) as { account?: { role?: string }; models?: { default_model?: string; models?: { id: string }[] } } | null
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
async function resolveFeatureModel(projectID: string, selected: Model, configured?: string): Promise<Model> {
  if (!configured || configured === (selected.modelID ?? selected.id)) return selected
  const authorized = await account.authorizeFeatureModel?.(configured)
  if (shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  if (!authorized) return selected
  const models = await adapter.models(projectID)
  if (shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  return models.find(model => model.providerID === 'amecode' && (model.modelID === authorized || model.id === authorized)) ?? selected
}
const translationModels = new Map<string, string>()
function translationKey(projectID: string, sessionID: string) { return JSON.stringify([projectID, sessionID]) }
async function resolveTranslationModel(projectID: string, sessionID: string, selected: Model): Promise<Model> {
  const key = translationKey(projectID, sessionID)
  let pinned = translationModels.get(key)
  if (!pinned) {
    const map = await adapter.agentMap(projectID, sessionID)
    const session = map.nodes.find(node => node.id === sessionID)
    if (session?.providerID !== 'amecode' || !session.model) throw new Error('TRANSLATION_MODEL_UNAVAILABLE')
    const models = await adapter.models(projectID)
    const model = models.find(model => model.providerID === 'amecode' && (model.id === session.model || model.modelID === session.model))
    pinned = model?.modelID ?? session.model
    translationModels.set(key, pinned)
  }
  const model = await resolveFeatureModel(projectID, selected, pinned)
  if ((model.modelID ?? model.id) !== pinned) throw new Error('TRANSLATION_MODEL_UNAVAILABLE')
  return model
}
function assertRegularSession(projectID: string, sessionID: string) {
  if (translationLocks?.isLocked(projectID, sessionID)) throw new Error('TRANSLATION_SESSION_LOCKED')
  if (translationLocks?.isTranslationSession(projectID, sessionID)) throw new Error('ANDROID_TRANSLATION_SESSION_REQUIRED')
}
function translationLockState(projectID: string): SessionLockState {
  return {
    translationSessionIDs: translationLocks?.translationSessionIDs(projectID) ?? [],
    lockedSessionIDs: translationLocks?.lockedSessionIDs(projectID) ?? []
  }
}
async function call(method: keyof typeof schema, args: unknown[]) {
  schema[method].parse(args)
  if (typeof shuttingDown !== 'undefined' && shuttingDown) throw new Error('APP_SHUTTING_DOWN')
  // Dispatch remains explicit: renderer never chooses arbitrary Node functions or IPC channels.
  const [a, b, c, d, e, f] = args as any[]
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
    case 'terminalSnapshot': return terminals.snapshot(a, b)
    case 'terminalWrite': return terminals.write(a, b, c)
    case 'terminalResize': return terminals.resize(a, b, c, d)
    case 'terminalClose': return terminals.close(a, b)
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
    case 'removeProject': {
      const project = workspace.get(a)
      await confirmation(`Gỡ dự án ${project.name} khỏi danh sách? Tệp trên ổ đĩa sẽ KHÔNG bị xóa.`)
      terminals.closeProject(a)
      await workspace.remove(a)
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
    case 'diff': return workspace.diff(a, b)
    case 'createFile': return workspace.createFile(a, b, c)
    case 'createDirectory': return workspace.createDirectory(a, b)
    case 'renamePath': return workspace.renamePath(a, b, c)
    case 'deletePath':
      await confirmation(`Xóa ${b} khỏi ổ đĩa? Hành động này không thể hoàn tác.`)
      return workspace.deletePath(a, b)
    case 'revealPath': {
      const { target } = await validateWorkspacePath(workspace.get(a).directory, b, { allowRoot: true })
      shell.showItemInFolder(target)
      return
    }
    case 'searchProject': return workspace.searchProject(a, b)
    case 'replaceInProject': {
      if (b.dryRun === true) return workspace.replaceInProject(a, b)
      const preview = await workspace.replaceInProject(a, { ...b, dryRun: true })
      if (preview.replacements === 0) return preview
      await confirmation(`Thay thế ${preview.replacements} vị trí trong ${preview.filesChanged} tệp?`)
      return workspace.replaceInProject(a, b)
    }
    case 'stageAll': return workspace.stageAll(a)
    case 'unstageAll': return workspace.unstageAll(a)
    case 'discardFile':
      await confirmation(`Hủy mọi thay đổi chưa lưu trong ${b}? Hành động này không thể hoàn tác.`)
      return workspace.discardFile(a, b)
    case 'gitBranches': return workspace.gitBranches(a)
    case 'checkoutBranch': return workspace.checkoutBranch(a, b)
    case 'createBranch': return workspace.createBranch(a, b, c)
    case 'stage': return workspace.stage(a, b, c)
    case 'commit': await confirmation(`Commit các thay đổi đã stage?\n${b}`); return workspace.commit(a, b)
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
      if (a.enabled && !pairing.status().enabled) await confirmation('Bật Remote access qua OpenTunnel? Máy chủ sẽ có địa chỉ Internet; lưu lượng được mã hóa đầu cuối tại Ame IDE. Thiết bị có mã QR hoặc link sẽ có toàn quyền OpenCode tích hợp. Không chia sẻ mã ghép nối.')
      return configurePairing(a)
    case 'pairingCode': return pairing.issue()
    case 'sessions': return adapter.sessions(a)
    case 'createSession': return adapter.createSession(a)
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
      return skill ? adapter.generateCommitMessage(summary, model, skill) : adapter.generateCommitMessage(summary, model)
    }
    case 'androidTranslationInfo': {
      const { directory } = workspace.get(a)
      const [detected, feature, status] = await Promise.all([
        detectAndroidProject(directory),
        account.readAndroidTranslationFeature?.(a),
        account.call('status', {}).catch(() => null)
      ])
      const catalog = (status as { models?: { default_model?: string; active_models?: { id: string; name?: string }[]; models?: { id: string; name?: string }[] } } | null)?.models
      const active = catalog?.active_models ?? catalog?.models ?? []
      const configured = feature?.model && active.find(model => model.id === feature.model)
      const effective = configured || active.find(model => model.id === catalog?.default_model)
      return {
        configured: !!(feature?.rawSkillName || feature?.skill), isAndroid: detected.isAndroid,
        skill: feature?.skill?.name ?? feature?.rawSkillName, configuredModelID: feature?.model,
        effectiveModelID: effective?.id, effectiveModelName: effective?.name ?? effective?.id,
        fallbackToDefault: !configured, stringsFiles: detected.stringsFiles, ...translationLockState(a)
      } satisfies AndroidTranslationInfo
    }
    case 'androidTranslationPrompt': {
      const { directory } = workspace.get(a)
      if (!translationLocks) throw new Error('TRANSLATION_LOCK_STORE_UNAVAILABLE')
      if (b && translationLocks.isLocked(a, b)) throw new Error('TRANSLATION_SESSION_LOCKED')
      if (b && !translationLocks.isTranslationSession(a, b)) throw new Error('ANDROID_TRANSLATION_SESSION_REQUIRED')
      const feature = await account.readAndroidTranslationFeature?.(a)
      if (!feature?.skill) throw new Error('ANDROID_TRANSLATION_NOT_CONFIGURED')
      const selected = await resolveModel(a)
      const model = b ? await resolveTranslationModel(a, b, selected) : await resolveFeatureModel(a, selected, feature.model)
      const detected = await detectAndroidProject(directory)
      const session = b ? (await adapter.sessions(a)).find(session => session.id === b) : await adapter.createSession(a)
      if (!session) throw new Error('SESSION_NOT_FOUND')
      const isFirstTurn = !b || (await adapter.messages(a, b)).length === 0
      await translationLocks.recordSession(a, session.id)
      translationModels.set(translationKey(a, session.id), model.modelID ?? model.id)
      const prompt = buildAndroidTranslationPrompt({
        userText: d && d !== 'custom' ? `[Translation mode: ${d}]\n${c}` : c,
        isFirstTurn, skill: feature.skill, stringsFiles: detected.stringsFiles
      })
      await adapter.prompt(a, session.id, prompt, model)
      return { session, model, locked: false } satisfies AndroidTranslationPromptResult
    }
    case 'androidTranslationLock': {
      workspace.get(a)
      if (!translationLocks?.isTranslationSession(a, b)) throw new Error('ANDROID_TRANSLATION_SESSION_REQUIRED')
      await translationLocks.lockSession(a, b)
      // prompt() acknowledges submission, not model completion; interrupt any remaining turn.
      try { await adapter.cancel(a, b) }
      finally { notify({ type: 'opencode', projectID: a, sessionID: b }) }
      return translationLockState(a)
    }
    case 'messages': return adapter.messages(a, b)
    case 'agentMap': return adapter.agentMap(a, b)
    case 'sessionDiff': return adapter.sessionDiff(a, b, c)
    case 'sessionUsage': {
      const pricing = await account.call('usage-prices', {}).catch(() => ({ origin: null, prices: {} })) as { origin: string | null; prices: UsagePrices }
      return adapter.sessionUsage(a, b, pricing.prices, pricing.origin)
    }
    case 'models': return adapter.models(a)
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
      const selected = await resolveModel(a, d, true)
      return adapter.prompt(a, b, c, selected, e, f)
    }
    case 'cancel': return adapter.cancel(a, b)
    case 'permissions': return adapter.permissions(a, b)
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
function dispatch(method: keyof typeof schema, args: unknown[]) {
  if (!['startBackend', 'connect', 'discover', 'prompt', 'generateCommitMessage', 'androidTranslationPrompt', 'androidTranslationLock', 'btwAsk', 'petGenerateDialogue', 'account', 'pairingConfigure'].includes(method)) return call(method, args)
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
  const devURL = process.env.ELECTRON_RENDERER_URL
  window.webContents.on('will-navigate', (event, target) => {
    if (target !== window?.webContents.getURL()) event.preventDefault()
  })
  window.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(window!, { type: 'warning', buttons: ['Ở lại', 'Bỏ thay đổi và đóng'], defaultId: 0, cancelId: 0, message: 'Có file chưa lưu. Đóng Ame IDE?' })
    if (response === 1) event.preventDefault()
  })
  window.webContents.on('render-process-gone', () => terminals.dispose())
  window.on('closed', () => { terminals.dispose(); window = undefined; petHost?.reconcile() })
  if (devURL) await window.loadURL(devURL)
  else await window.loadFile(path.join(here, '../renderer/index.html'))
  petHost?.reconcile()
}
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
void app.whenReady().then(async () => {
  if (!primaryInstance) return
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]))
  workspace = new Workspaces(path.join(app.getPath('userData'), 'projects.json'), projectID => {
    void lspServices.get(projectID)?.refreshFiles().catch(() => {})
    notify({ type: 'files', projectID })
  })
  await workspace.load()
  translationLocks = createTranslationLockStore(path.join(app.getPath('userData'), 'translation-locks.json'))
  await translationLocks.load()
  terminals = new Terminals(projectID => workspace.get(projectID).directory, notify)
  adapter = new OpenCodeAdapter(notify)
  for (const project of workspace.list()) adapter.attach(project.id, project.directory)
  const spritePath = app.isPackaged ? path.join(process.resourcesPath, 'ame-chibi.png') : path.join(app.getAppPath(), 'packages/amekit/src/assets/ame-chibi.png')
  sprite = await loadPetSprite(spritePath).catch(() => '')
  petHost = createPetHost({ userData: app.getPath('userData'), electron: { BrowserWindow, screen }, sprite, defaultEnabled: false,
    hasMainWindow: () => Boolean(window && !window.isDestroyed()), onStateChanged: state => notify({ type: 'pet', state }),
    generateDialogue: (model, signal) => account.generatePetDialogue(model, signal) })
  runtime = new PrivateRuntime({ resources: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), profile: path.join(app.getPath('userData'), 'backend'), onExit: () => {
    if (managed && !shuttingDown) { void pairing?.stop(); adapter.disconnected('OpenCode tích hợp đã dừng. Mở Cài đặt để thử lại.') }
  } })
  pairing = new RemotePairing(new PairingHost(() => managed ? adapter.endpoint() : undefined), automaticTunnel(path.join(app.getPath('userData'), 'remote-access')))
  account = createAmeKit({ userData: app.getPath('userData'), endpoint: () => adapter.endpoint(), project: async projectID => workspace.get(projectID).directory, pickImport, cli: runtime.executable() })
  await petHost.init()
  ipcMain.handle('ame:call', async (event, method: unknown, args: unknown) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('UNTRUSTED_CALLER')
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
  if (quitting || !account) return
  event.preventDefault(); quitting = true; shuttingDown = true
  screenActive(false)
  terminals?.dispose()
  // Abort in-flight pet generation before waiting for authority; queued calls fail closed.
  void Promise.resolve().then(() => petHost?.dispose()).finally(async () => {
    for (const service of lspServices.values()) { try { service.dispose() } catch { /* Continue disposing other projects. */ } }
    lspServices.clear()
    await Promise.allSettled([...debuggers.values()].map(async service => service.dispose()))
    debuggers.clear()
  }).finally(() => authority.catch(() => {}))
    .finally(() => pairing.stop()).finally(() => account.dispose()).finally(async () => { adapter.dispose(); workspace.dispose(); await runtime.stop(); app.quit() })
})
