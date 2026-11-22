export type Project = { id: string; name: string; directory: string }
export type FileEntry = { path: string; name: string; directory: boolean }
export type FileDocument = { path: string; content: string; revision: string }
export type Change = { path: string; index: string; working: string }
export type GitState = { branch: string; changes: Change[] }
export type GitBranch = { name: string; current: boolean; commit: string }
export type GitBranches = { current: string; branches: GitBranch[] }
export type SearchQuery = {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string[]
  exclude?: string[]
  maxFiles?: number
  maxMatches?: number
}
export type SearchMatch = { line: number; column: number; length: number; lineText: string; matchText: string }
export type SearchFileResult = { path: string; matches: SearchMatch[] }
export type SearchResponse = { results: SearchFileResult[]; totalMatches: number; filesSearched: number; truncated: boolean; engine: 'ripgrep' | 'node' }
export type ReplaceOptions = SearchQuery & { replacement: string; files?: string[]; dryRun?: boolean }
export type ReplaceResult = { filesChanged: number; replacements: number; previews: { path: string; count: number; sampleBefore: string; sampleAfter: string }[] }
export type Session = { id: string; title: string; updatedAt?: number; parentID?: string; agent?: string; status?: 'running' | 'idle'; outcome?: 'succeeded' | 'failed' | 'interrupted' }
export type SessionDiff = { file: string; patch: string; additions: number; deletions: number; status: 'added' | 'deleted' | 'modified'; more?: true }
export type ToolCallInfo = {
  name: string
  status: 'streaming' | 'running' | 'completed' | 'error'
  target?: string
  input?: unknown
  output?: string
  error?: string
  durationMs?: number
}
export type SlashCommand = { name: string; description?: string }
export type SkillSummary = { id: string; name: string; description?: string; path: string }
export type ChatItem = { id: string; role: string; text: string; kind?: string; tool?: ToolCallInfo; turn?: { from: string; files: string[] } }
export type Model = { id: string; modelID?: string; name: string; providerID: string }
export type Agent = { id: string; name: string }
export type Permission = { id: string; sessionID: string; title: string }
export type Connection = { connected: boolean; url: string; version?: string; error?: string }
export type PairingPreferences = { enabled: boolean; keepScreenActive: boolean }
export type PairingSettings = PairingPreferences & { publicURL: string; port: number; connecting?: boolean; error?: string }
export type PairingCode = { url: string; qr: string; expiresAt: number }
export type AccountView = { origin?: string; account?: { name: string; username: string; role?: string }; models?: unknown; reconnecting?: boolean } | null
export type TerminalProfile = { id: string; name: string; executable: string; args: string[] }
export type TerminalInfo = { id: string; projectID: string; title: string; cols: number; rows: number; exitCode?: number }
export type TerminalSnapshot = TerminalInfo & { output: string; sequence: number }
export type TerminalEvent = { type: 'terminal'; projectID: string; terminalID: string; sequence: number; data?: string; exitCode?: number }
export type IdeEvent = { type: 'files'; projectID: string } | { type: 'opencode'; projectID: string; sessionID?: string } | { type: 'connection'; connection: Connection } | TerminalEvent
export interface DesktopApi {
  terminalProfiles(): Promise<Pick<TerminalProfile, 'id' | 'name'>[]>
  terminalList(projectID: string): Promise<TerminalInfo[]>
  terminalCreate(projectID: string, profileID?: string, cols?: number, rows?: number): Promise<TerminalInfo>
  terminalSnapshot(projectID: string, terminalID: string): Promise<TerminalSnapshot>
  terminalWrite(projectID: string, terminalID: string, data: string): Promise<void>
  terminalResize(projectID: string, terminalID: string, cols: number, rows: number): Promise<void>
  terminalClose(projectID: string, terminalID: string): Promise<void>
  projects(): Promise<Project[]>
  pickProject(): Promise<Project | null>
  removeProject(projectID: string): Promise<void>
  entries(projectID: string, relative: string): Promise<FileEntry[]>
  read(projectID: string, relative: string): Promise<FileDocument>
  save(projectID: string, relative: string, content: string, revision: string): Promise<FileDocument>
  createFile(projectID: string, relative: string, content?: string): Promise<{ path: string }>
  createDirectory(projectID: string, relative: string): Promise<{ path: string }>
  renamePath(projectID: string, fromRelative: string, toRelative: string): Promise<{ from: string; to: string }>
  deletePath(projectID: string, relative: string): Promise<{ path: string; directory: boolean }>
  revealPath(projectID: string, relative: string): Promise<void>
  searchProject(projectID: string, query: SearchQuery): Promise<SearchResponse>
  replaceInProject(projectID: string, options: ReplaceOptions): Promise<ReplaceResult>
  stageAll(projectID: string): Promise<void>
  unstageAll(projectID: string): Promise<void>
  discardFile(projectID: string, relative: string): Promise<void>
  gitBranches(projectID: string): Promise<GitBranches>
  checkoutBranch(projectID: string, name: string): Promise<void>
  createBranch(projectID: string, name: string, checkout?: boolean): Promise<void>
  git(projectID: string): Promise<GitState>
  diff(projectID: string, relative: string): Promise<{ original: string; modified: string }>
  stage(projectID: string, relative: string, staged: boolean): Promise<void>
  commit(projectID: string, message: string): Promise<void>
  connection(): Promise<Connection>
  startBackend(): Promise<Connection>
  pairingStatus(): Promise<PairingSettings>
  pairingConfigure(settings: PairingPreferences): Promise<PairingSettings>
  pairingCode(): Promise<PairingCode>
  connect(url: string, username?: string, password?: string): Promise<Connection>
  discover(): Promise<Connection>
  sessions(projectID: string): Promise<Session[]>
  createSession(projectID: string): Promise<Session>
  renameSession(projectID: string, sessionID: string, title: string): Promise<void>
  archiveSession(projectID: string, sessionID: string, archived: boolean): Promise<void>
  deleteSession(projectID: string, sessionID: string): Promise<void>
  commands(projectID: string): Promise<SlashCommand[]>
  skills(projectID: string): Promise<SkillSummary[]>
  generateCommitMessage(projectID: string, model?: Model): Promise<{ message: string; truncated: boolean }>
  messages(projectID: string, sessionID: string): Promise<ChatItem[]>
  sessionDiff(projectID: string, sessionID: string, from?: string): Promise<SessionDiff[]>
  models(projectID: string): Promise<Model[]>
  agents(projectID: string): Promise<Agent[]>
  prompt(projectID: string, sessionID: string, text: string, model?: Model, agent?: string): Promise<void>
  cancel(projectID: string, sessionID: string): Promise<void>
  permissions(projectID: string, sessionID: string): Promise<Permission[]>
  replyPermission(projectID: string, permissionID: string, reply: 'once' | 'always' | 'reject'): Promise<void>
  account(operation: string, payload?: Record<string, string>): Promise<unknown>
  pickImport(): Promise<string | null>
  window(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  onEvent(listener: (event: IdeEvent) => void): () => void
}
declare global { interface Window { ame: DesktopApi } }
