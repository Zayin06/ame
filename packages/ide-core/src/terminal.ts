import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn, type IPty } from 'node-pty'
import type { TerminalEvent, TerminalInfo, TerminalProfile, TerminalSnapshot } from '../../protocol/src/index'

export function shellProfiles(platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists = existsSync): TerminalProfile[] {
  if (platform === 'win32') {
    const root = env.SystemRoot || 'C:\\Windows'
    const profiles: TerminalProfile[] = [
      { id: 'powershell', name: 'PowerShell', executable: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
      { id: 'cmd', name: 'Command Prompt', executable: env.ComSpec || path.win32.join(root, 'System32', 'cmd.exe'), args: [] }
    ]
    const pwsh = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    if (exists(pwsh)) profiles.unshift({ id: 'pwsh', name: 'PowerShell 7', executable: pwsh, args: ['-NoLogo'] })
    return profiles.filter(profile => exists(profile.executable))
  }
  const candidates = [env.SHELL, ...(platform === 'darwin' ? ['/bin/zsh', '/bin/bash'] : ['/bin/bash', '/bin/sh'])]
  return [...new Set(candidates)].filter((shell): shell is string => !!shell && path.posix.isAbsolute(shell) && exists(shell)).map((shell, index) => ({ id: `shell-${index}`, name: path.posix.basename(shell), executable: shell, args: ['-l'] }))
}

export class Terminals {
  private sessions = new Map<string, { info: TerminalInfo; pty: IPty; output: string; sequence: number; listeners: { dispose(): void }[] }>()
  constructor(private directory: (projectID: string) => string, private emit: (event: TerminalEvent) => void, private profiles = shellProfiles(), private launch: typeof spawn = spawn) {}
  available() { return this.profiles.map(({ id, name }) => ({ id, name })) }
  list(projectID: string) { this.directory(projectID); return [...this.sessions.values()].filter(session => session.info.projectID === projectID).map(session => ({ ...session.info })) }
  create(projectID: string, profileID?: string, cols = 80, rows = 24): TerminalInfo {
    this.dimensions(cols, rows)
    const cwd = this.directory(projectID)
    if (this.sessions.size >= 20) throw new Error('TERMINAL_LIMIT: Đóng bớt terminal trước khi tạo mới.')
    const profile = profileID ? this.profiles.find(profile => profile.id === profileID) : this.profiles[0]
    if (!profile) throw new Error('TERMINAL_PROFILE_UNAVAILABLE')
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !/^(ELECTRON_|AME_|NODE_OPTIONS$|NODE_INSPECT|OPENCODE_SERVER_)/i.test(entry[0])))
    const pty = this.launch(profile.executable, profile.args, { name: 'xterm-256color', cwd, cols, rows, env: { ...env, TERM_PROGRAM: 'Ame', COLORTERM: 'truecolor' } })
    const info: TerminalInfo = { id: randomUUID(), projectID, title: profile.name, cols, rows }
    const session = { info, pty, output: '', sequence: 0, listeners: [] as { dispose(): void }[] }
    this.sessions.set(info.id, session)
    session.listeners.push(pty.onData(data => {
      session.output = (session.output + data).slice(-1024 * 1024)
      this.emit({ type: 'terminal', projectID, terminalID: info.id, sequence: ++session.sequence, data })
    }), pty.onExit(({ exitCode }) => {
      info.exitCode = exitCode
      this.emit({ type: 'terminal', projectID, terminalID: info.id, sequence: ++session.sequence, exitCode })
      session.listeners.splice(0).forEach(listener => listener.dispose())
    }))
    return { ...info }
  }
  snapshot(projectID: string, id: string): TerminalSnapshot {
    const session = this.get(projectID, id)
    return { ...session.info, output: session.output, sequence: session.sequence }
  }
  write(projectID: string, id: string, data: string) {
    if (typeof data !== 'string' || data.length > 65536) throw new Error('INVALID_TERMINAL_INPUT')
    const session = this.get(projectID, id)
    if (session.info.exitCode !== undefined) throw new Error('TERMINAL_EXITED')
    session.pty.write(data)
  }
  resize(projectID: string, id: string, cols: number, rows: number) {
    this.dimensions(cols, rows)
    const session = this.get(projectID, id)
    if (session.info.exitCode !== undefined) return
    if (cols === session.info.cols && rows === session.info.rows) return
    session.pty.resize(cols, rows); Object.assign(session.info, { cols, rows })
  }
  close(projectID: string, id: string) {
    const session = this.get(projectID, id)
    session.listeners.forEach(listener => listener.dispose())
    this.sessions.delete(id)
    if (session.info.exitCode === undefined) { try { session.pty.kill() } catch { /* The shell may already have exited. */ } }
  }
  dispose() { for (const { info } of this.sessions.values()) this.close(info.projectID, info.id) }
  private get(projectID: string, id: string) {
    const session = this.sessions.get(id)
    if (!session || session.info.projectID !== projectID) throw new Error('UNKNOWN_TERMINAL')
    return session
  }
  private dimensions(cols: number, rows: number) { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) throw new Error('INVALID_TERMINAL_SIZE') }
}
