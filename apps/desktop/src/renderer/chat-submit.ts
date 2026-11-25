import type { DesktopApi, Model, PermissionMode, PromptFileAttachment, Session } from '../../../../packages/protocol/src/index'

export function chatSubmit(api: Pick<DesktopApi, 'createSession' | 'prompt'>, onCreated: (session: Session, draftID: number) => void) {
  const drafts = new Map<string, { pending: boolean; session?: Session }>()
  return async (projectID: string, sessionID: string | undefined, text: string, model: Model, agent?: string, files?: PromptFileAttachment[], draftID = 0, permissionMode?: PermissionMode) => {
    if (!text.trim() && !files?.length) return false
    const key = JSON.stringify([projectID, draftID])
    let draft = drafts.get(key)
    if (!draft) { draft = { pending: false }; drafts.set(key, draft) }
    if (draft.pending) return false
    draft.pending = true
    try {
      if (!sessionID && !draft.session) {
        draft.session = permissionMode === undefined ? await api.createSession(projectID) : await api.createSession(projectID, permissionMode)
        onCreated(draft.session, draftID)
      }
      if (files?.length) await api.prompt(projectID, sessionID || draft.session!.id, text, model, agent, files)
      else await api.prompt(projectID, sessionID || draft.session!.id, text, model, agent)
      return true
    } finally { draft.pending = false }
  }
}
