import type { DesktopApi, Model, PromptFileAttachment, Session } from '../../../../packages/protocol/src/index'

export function chatSubmit(api: Pick<DesktopApi, 'createSession' | 'prompt'>, onCreated: (session: Session) => void) {
  let pending = false
  let draft: Session | undefined
  return async (projectID: string, sessionID: string | undefined, text: string, model: Model, agent?: string, files?: PromptFileAttachment[]) => {
    if (pending || (!text.trim() && !(files?.length))) return false
    pending = true
    try {
      if (!sessionID && !draft) {
        draft = await api.createSession(projectID)
        onCreated(draft)
      }
      if (files?.length) await api.prompt(projectID, sessionID || draft!.id, text, model, agent, files)
      else await api.prompt(projectID, sessionID || draft!.id, text, model, agent)
      return true
    } finally { pending = false }
  }
}
