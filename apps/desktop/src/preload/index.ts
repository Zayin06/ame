import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, IdeEvent } from '../../../../packages/protocol/src/index'

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('ame:call', method, args)
const api: DesktopApi = {
  terminalProfiles: () => invoke('terminalProfiles'), terminalList: id => invoke('terminalList', id),
  terminalCreate: (id, profile, cols, rows) => invoke('terminalCreate', id, profile, cols, rows),
  terminalSnapshot: (id, terminal) => invoke('terminalSnapshot', id, terminal),
  terminalWrite: (id, terminal, data) => invoke('terminalWrite', id, terminal, data),
  terminalResize: (id, terminal, cols, rows) => invoke('terminalResize', id, terminal, cols, rows),
  terminalClose: (id, terminal) => invoke('terminalClose', id, terminal),
  projects: () => invoke('projects'), pickProject: () => invoke('pickProject'), removeProject: id => invoke('removeProject', id),
  entries: (id, relative) => invoke('entries', id, relative), read: (id, relative) => invoke('read', id, relative),
  save: (id, relative, content, revision) => invoke('save', id, relative, content, revision),
  createFile: (id, relative, content) => invoke('createFile', id, relative, content),
  createDirectory: (id, relative) => invoke('createDirectory', id, relative),
  renamePath: (id, from, to) => invoke('renamePath', id, from, to),
  deletePath: (id, relative) => invoke('deletePath', id, relative),
  revealPath: (id, relative) => invoke('revealPath', id, relative),
  searchProject: (id, query) => invoke('searchProject', id, query),
  replaceInProject: (id, options) => invoke('replaceInProject', id, options),
  stageAll: id => invoke('stageAll', id), unstageAll: id => invoke('unstageAll', id),
  discardFile: (id, relative) => invoke('discardFile', id, relative),
  gitBranches: id => invoke('gitBranches', id),
  checkoutBranch: (id, name) => invoke('checkoutBranch', id, name),
  createBranch: (id, name, checkout) => invoke('createBranch', id, name, checkout),
  git: id => invoke('git', id), diff: (id, relative) => invoke('diff', id, relative),
  stage: (id, relative, staged) => invoke('stage', id, relative, staged), commit: (id, message) => invoke('commit', id, message),
  connection: () => invoke('connection'), startBackend: () => invoke('startBackend'), connect: (url, username, password) => invoke('connect', url, username, password), discover: () => invoke('discover'),
  pairingStatus: () => invoke('pairingStatus'), pairingConfigure: settings => invoke('pairingConfigure', settings), pairingCode: () => invoke('pairingCode'),
  sessions: id => invoke('sessions', id), createSession: id => invoke('createSession', id), messages: (id, session) => invoke('messages', id, session),
  renameSession: (id, session, title) => invoke('renameSession', id, session, title),
  archiveSession: (id, session, archived) => invoke('archiveSession', id, session, archived),
  deleteSession: (id, session) => invoke('deleteSession', id, session),
  commands: id => invoke('commands', id), skills: id => invoke('skills', id),
  generateCommitMessage: (id, model) => invoke('generateCommitMessage', id, model),
  sessionDiff: (id, session, from) => invoke('sessionDiff', id, session, from),
  models: id => invoke('models', id), agents: id => invoke('agents', id),
  prompt: (id, session, text, model, agent) => invoke('prompt', id, session, text, model, agent),
  cancel: (id, session) => invoke('cancel', id, session), permissions: (id, session) => invoke('permissions', id, session),
  replyPermission: (id, permission, reply) => invoke('replyPermission', id, permission, reply),
  account: (operation, payload = {}) => invoke('account', operation, payload), pickImport: () => invoke('pickImport'),
  window: action => invoke('window', action),
  onEvent: listener => {
    const receive = (_: unknown, event: IdeEvent) => listener(event)
    ipcRenderer.on('ame:event', receive)
    return () => { ipcRenderer.removeListener('ame:event', receive) }
  }
}
contextBridge.exposeInMainWorld('ame', api)
