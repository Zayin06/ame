import type { DesktopApi } from '../../../../packages/protocol/src/index'

export const terminalTheme = (theme: string) => theme === 'light'
  ? { background: '#ffffff', foreground: '#24292f', cursor: '#24292f' }
  : { background: '#14161a', foreground: '#d4d4d4', cursor: '#d4d4d4' }

export function updateTerminalTheme(terminal: { options: { theme?: Partial<ReturnType<typeof terminalTheme>> } } | null, theme: string) {
  if (terminal) terminal.options.theme = terminalTheme(theme)
}
export function clearTerminal(terminal: { clear(): void } | null) { terminal?.clear() }

export const isTerminalKey = (event: { code: string; key: string }) => event.code === 'Backquote' || event.key === '`' || event.key === '~'
export const newTerminalShortcut = (event: { code: string; key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean }) => (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && !event.isComposing && isTerminalKey(event)

export async function createProjectTerminal(api: Pick<DesktopApi, 'terminalProfiles' | 'terminalCreate'>, projectID?: string) {
  if (!projectID) return
  const profiles = await api.terminalProfiles()
  if (profiles.length) return api.terminalCreate(projectID, profiles[0].id)
}
