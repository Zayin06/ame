export type CommitState = { busy: boolean; message: string; changes: ReadonlyArray<{ index: string }>; amend?: boolean }
export const canCommit = ({ busy, message, changes, amend }: CommitState) => !busy && !!message.trim() && (!!amend || changes.some(change => !!change.index.trim() && !['?', '!'].includes(change.index)))

export function commitShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault(): void }, state: CommitState, submit: () => void) {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return
  event.preventDefault()
  if (canCommit(state)) submit()
}
