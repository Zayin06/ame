export function isMacPlatform(platform?: string): boolean { return platform === 'darwin' }

export function formatShortcut(shortcut: string, isMac: boolean): string {
  if (!isMac) return shortcut
  const parts = shortcut.replace(/Ctrl\s*\/\s*Cmd/gi, 'Ctrl').split('+').map(part => part.trim())
  const modifiers = new Set(parts.slice(0, -1).map(part => part.toLowerCase()))
  const key = parts.at(-1) || ''
  return `${modifiers.has('shift') ? '⇧' : ''}${modifiers.has('alt') || modifiers.has('option') ? '⌥' : ''}${modifiers.has('ctrl') || modifiers.has('control') || modifiers.has('cmd') || modifiers.has('meta') ? '⌘' : ''}${key}`
}
