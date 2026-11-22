import { tabID, type Tab } from './state'
import { containsPath, renamedPath } from './workspace-paths'

export type EditorGroupID = 'primary' | 'secondary'
export type EditorGroup = { tabs: Tab[]; active?: Tab }
export type EditorSplitState = { primary: EditorGroup; secondary?: EditorGroup; focused: EditorGroupID }

function makeGroup(tabs: readonly Tab[], active?: Tab): EditorGroup {
  const unique = Array.from(new Map(tabs.map(tab => [tabID(tab), tab])).values())
  return { tabs: unique, active: unique.find(tab => active && tabID(tab) === tabID(active)) ?? unique[0] }
}

function collapseEmpty(state: EditorSplitState): EditorSplitState {
  if (state.secondary?.tabs.length) return state
  const { secondary: _, ...rest } = state
  return { ...rest, focused: 'primary' }
}

export function createSplitState(tabs: readonly Tab[] = [], active?: Tab): EditorSplitState {
  return { primary: makeGroup(tabs, active), focused: 'primary' }
}

export function splitRight(state: EditorSplitState, tab?: Tab): EditorSplitState {
  const next = { ...state, secondary: state.secondary ?? makeGroup([]), focused: 'secondary' as const }
  const selected = tab ?? state.primary.active
  return selected ? openTabInGroup(next, selected, 'secondary') : next
}

export function unsplit(state: EditorSplitState): EditorSplitState {
  if (!state.secondary) return state
  const active = state.focused === 'secondary' ? state.secondary.active ?? state.primary.active : state.primary.active
  return { primary: makeGroup([...state.primary.tabs, ...state.secondary.tabs], active), focused: 'primary' }
}

export function focusGroup(state: EditorSplitState, group: EditorGroupID): EditorSplitState {
  return group === 'secondary' && !state.secondary ? state : { ...state, focused: group }
}

export function openTabInGroup(state: EditorSplitState, tab: Tab, group: EditorGroupID = state.focused): EditorSplitState {
  const current = state[group] ?? makeGroup([])
  const existing = current.tabs.find(item => tabID(item) === tabID(tab))
  return { ...state, [group]: { tabs: existing ? current.tabs : [...current.tabs, tab], active: existing ?? tab }, focused: group }
}

export function selectTabInGroup(state: EditorSplitState, tab: Tab, group: EditorGroupID): EditorSplitState {
  const current = state[group]
  const active = current?.tabs.find(item => tabID(item) === tabID(tab))
  return current && active ? { ...state, [group]: { ...current, active }, focused: group } : state
}

function removeFromGroup(group: EditorGroup, tab: Tab): EditorGroup {
  const index = group.tabs.findIndex(item => tabID(item) === tabID(tab))
  if (index === -1) return group
  const tabs = group.tabs.filter(item => tabID(item) !== tabID(tab))
  const active = group.active && tabID(group.active) !== tabID(tab) ? group.active : tabs[Math.min(index, tabs.length - 1)]
  return { tabs, active }
}

export function closeTabInGroup(state: EditorSplitState, tab: Tab, group: EditorGroupID): EditorSplitState {
  const current = state[group]
  if (!current || !current.tabs.some(item => tabID(item) === tabID(tab))) return state
  return collapseEmpty({ ...state, [group]: removeFromGroup(current, tab) })
}

export function moveTabToOtherGroup(state: EditorSplitState, tab: Tab, from: EditorGroupID): EditorSplitState {
  const source = state[from]
  const existing = source?.tabs.find(item => tabID(item) === tabID(tab))
  if (!source || !existing) return state
  const target = from === 'primary' ? 'secondary' : 'primary'
  const opened = openTabInGroup(state, existing, target)
  return collapseEmpty({ ...opened, [from]: removeFromGroup(source, existing) })
}

const normalizedPath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

export function renameInSplitState(state: EditorSplitState, from: string, to: string): EditorSplitState {
  const parent = normalizedPath(from), destination = normalizedPath(to)
  if (!parent || !destination) return state
  const renameGroup = (group: EditorGroup): EditorGroup => {
    const rename = (tab: Tab): Tab => {
      const path = normalizedPath(tab.path)
      return containsPath(parent, path) ? { ...tab, path: renamedPath(path, parent, destination) } : tab
    }
    return makeGroup(group.tabs.map(rename), group.active && rename(group.active))
  }
  return { ...state, primary: renameGroup(state.primary), ...(state.secondary ? { secondary: renameGroup(state.secondary) } : {}) }
}

export function deleteInSplitState(state: EditorSplitState, deletedPath: string): EditorSplitState {
  const parent = normalizedPath(deletedPath)
  if (!parent) return state
  const prune = (group: EditorGroup) => group.tabs.filter(tab => containsPath(parent, normalizedPath(tab.path))).reduce(removeFromGroup, group)
  return collapseEmpty({ ...state, primary: prune(state.primary), ...(state.secondary ? { secondary: prune(state.secondary) } : {}) })
}
