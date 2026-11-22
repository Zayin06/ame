import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { PairingHost } from '../../../../packages/opencode-adapter/src/pairing'
import { RemotePairing, automaticTunnel } from '../../../../packages/opencode-adapter/src/remote-pairing'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Workspaces } from '../../../../packages/ide-core/src/workspace'
import { Terminals } from '../../../../packages/ide-core/src/terminal'
import { OpenCodeAdapter } from '../../../../packages/opencode-adapter/src/index'
import { PrivateRuntime } from '../../../../packages/opencode-adapter/src/runtime'
import { createAmeKit } from '../../../../packages/amekit/src/index'
import type { IdeEvent } from '../../../../packages/protocol/src/index'

if (!app.isPackaged && process.env.AME_IDE_TEST_DATA) app.setPath('userData', path.resolve(process.env.AME_IDE_TEST_DATA))
const here = path.dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | undefined
let workspace: Workspaces
let terminals: Terminals
let adapter: OpenCodeAdapter
let account: ReturnType<typeof createAmeKit>
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
const schema = {
  terminalProfiles: z.tuple([]), terminalList: z.tuple([id]),
  terminalCreate: z.tuple([id, id.optional(), z.number().int().min(2).max(500).optional(), z.number().int().min(1).max(300).optional()]),
  terminalSnapshot: z.tuple([id, id]), terminalWrite: z.tuple([id, id, z.string().max(65536)]),
  terminalResize: z.tuple([id, id, z.number().int().min(2).max(500), z.number().int().min(1).max(300)]), terminalClose: z.tuple([id, id]),
  projects: z.tuple([]), pickProject: z.tuple([]), removeProject: z.tuple([id]), entries: z.tuple([id, relative]), read: z.tuple([id, relative]),
  save: z.tuple([id, relative, z.string().max(4 * 1024 * 1024), z.string().regex(/^[a-f0-9]{64}$/)]),
  git: z.tuple([id]), diff: z.tuple([id, relative]), stage: z.tuple([id, relative, z.boolean()]), commit: z.tuple([id, z.string().min(1).max(10000)]),
  connection: z.tuple([]), startBackend: z.tuple([]), discover: z.tuple([]), connect: z.tuple([z.string().max(2048), z.string().max(512).optional(), z.string().max(8192).optional()]),
  sessions: z.tuple([id]), createSession: z.tuple([id]), messages: z.tuple([id, id]), sessionDiff: z.tuple([id, id, id.optional()]), models: z.tuple([id]), agents: z.tuple([id]),
  prompt: z.tuple([id, id, text, z.object({ id, modelID: id.optional(), name: z.string().max(512), providerID: id }).optional(), id.optional()]),
  cancel: z.tuple([id, id]), permissions: z.tuple([id, id]), replyPermission: z.tuple([id, id, z.enum(['once', 'always', 'reject'])]),
  pairingStatus: z.tuple([]), pairingConfigure: z.tuple([pairingSchema]), pairingCode: z.tuple([]),
  account: z.tuple([z.string().max(64), z.record(z.string(), z.string().max(8192))]), pickImport: z.tuple([]), window: z.tuple([z.enum(['minimize', 'maximize', 'close'])])
} as const
function notify(event: IdeEvent) { if (window && !window.isDestroyed()) window.webContents.send('ame:event', event) }
async function confirmation(message: string) {
  const result = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Hủy', 'Xác nhận'], defaultId: 0, cancelId: 0, message })
  if (result.response !== 1) throw new Error('CANCELLED')
}
async function pickImport() {
  const selected = await dialog.showOpenDialog(window!, { title: 'Import AmeKit agents / skills', properties: ['openDirectory'] })
  return selected.canceled ? null : selected.filePaths[0] ?? null
}
async function call(method: keyof typeof schema, args: unknown[]) {
  schema[method].parse(args)
  // Dispatch remains explicit: renderer never chooses arbitrary Node functions or IPC channels.
  const [a, b, c, d, e] = args as any[]
  switch (method) {
    case 'terminalProfiles': return terminals.available()
    case 'terminalList': return terminals.list(a)
    case 'terminalCreate': return terminals.create(a, b, c, d)
    case 'terminalSnapshot': return terminals.snapshot(a, b)
    case 'terminalWrite': return terminals.write(a, b, c)
    case 'terminalResize': return terminals.resize(a, b, c, d)
    case 'terminalClose': return terminals.close(a, b)
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
      adapter.detach(a)
      return
    }
    case 'entries': return workspace.entries(a, b)
    case 'read': return workspace.read(a, b)
    case 'save': return workspace.save(a, b, c, d)
    case 'git': return workspace.status(a)
    case 'diff': return workspace.diff(a, b)
    case 'stage': await confirmation(`${c ? 'Stage' : 'Unstage'} ${b}?`); return workspace.stage(a, b, c)
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
    case 'messages': return adapter.messages(a, b)
    case 'sessionDiff': return adapter.sessionDiff(a, b, c)
    case 'models': return adapter.models(a)
    case 'agents': return adapter.agents(a)
    case 'prompt': {
      const selected = d && (await adapter.models(a)).find(model => model.id === d.id && model.providerID === 'amecode')
      if (!selected) throw new Error('AMEKIT_MODEL_REQUIRED')
      await account.call('assert-model', { modelID: selected.modelID ?? selected.id, providerID: selected.providerID })
      return adapter.prompt(a, b, c, selected, e)
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
  if (!['startBackend', 'connect', 'discover', 'prompt', 'account', 'pairingConfigure'].includes(method)) return call(method, args)
  // A prompt's fresh policy check and submission cannot straddle an endpoint switch.
  const task = authority.catch(() => {}).then(() => call(method, args))
  authority = task
  return task
}
async function openWindow() {
  window = new BrowserWindow({ width: 1536, height: 960, minWidth: 1000, minHeight: 640, title: 'Ame IDE', backgroundColor: '#16181d', frame: false,
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
  window.on('closed', () => { terminals.dispose(); window = undefined })
  if (devURL) await window.loadURL(devURL)
  else await window.loadFile(path.join(here, '../renderer/index.html'))
}
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
void app.whenReady().then(async () => {
  if (!primaryInstance) return
  workspace = new Workspaces(path.join(app.getPath('userData'), 'projects.json'), projectID => notify({ type: 'files', projectID }))
  await workspace.load()
  terminals = new Terminals(projectID => workspace.get(projectID).directory, notify)
  adapter = new OpenCodeAdapter(notify)
  for (const project of workspace.list()) adapter.attach(project.id, project.directory)
  runtime = new PrivateRuntime({ resources: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), profile: path.join(app.getPath('userData'), 'backend'), onExit: () => {
    if (managed && !shuttingDown) { void pairing?.stop(); adapter.disconnected('OpenCode tích hợp đã dừng. Mở Cài đặt để thử lại.') }
  } })
  pairing = new RemotePairing(new PairingHost(() => managed ? adapter.endpoint() : undefined), automaticTunnel(path.join(app.getPath('userData'), 'remote-access')))
  account = createAmeKit({ userData: app.getPath('userData'), endpoint: () => adapter.endpoint(), project: async projectID => workspace.get(projectID).directory, pickImport, cli: runtime.executable() })
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
  void authority.catch(() => {}).then(() => pairing.stop()).finally(() => account.dispose()).finally(async () => { adapter.dispose(); workspace.dispose(); await runtime.stop(); app.quit() })
})
