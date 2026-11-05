import { useCallback } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { InteractionPending } from '../api/types'
import { useToasts } from '../hooks/useToasts'
import type { ToastView } from '../hooks/useToasts'
import { useSessionChannel } from '../hooks/useSessionChannel'
import { placedAboveNotice, useComposerDraft } from './useComposerDraft'

interface SessionCompose {
  draft: string
  // setDraft applies one edit and writes through to storage.
  setDraft: (text: string) => void
  // placedAbove places text under the prepend rule, announcing a merge above
  // an existing draft with a toast.
  placedAbove: (text: string) => void
  // recallToEdit pops the newest queued prompt back into the composer; secret
  // rows refuse upstream and their toast says so.
  recallToEdit: () => Promise<void>
  // dialogs is the open-dialog set; while it holds input the composer disables.
  dialogs: InteractionPending[]
  composerDisabled: boolean
  disabledReason: string
  toasts: ToastView[]
  pushToast: (text: string, level?: 'info' | 'error') => void
}

// useSessionCompose owns the session-compose glue every screen shares:
// composer draft with its persistence rules, recall-to-edit, prefill
// placement notices, the toast stack those surface through, and the disabled
// state a holding dialog or unreachable session forces onto the composer.
export function useSessionCompose(sessionId: string): SessionCompose {
  const { state, phase } = useSessionChannel(sessionId)
  const { draft, setDraft, prefill } = useComposerDraft(sessionId)
  const { toasts, pushToast } = useToasts()

  // placedAbove surfaces a prefill that merged above an existing draft, so the
  // arrival is noticed instead of reading as one's own text moving down.
  const placedAbove = useCallback(
    (text: string) => {
      if (prefill(text)) pushToast(placedAboveNotice)
    },
    [prefill, pushToast],
  )

  const recallToEdit = useCallback(async () => {
    try {
      const row = await sessionAPI.recall(sessionId)
      if (row.text) placedAbove(row.text)
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : 'Recall failed.', 'error')
    }
  }, [sessionId, placedAbove, pushToast])

  // A dialog holding input disables the composer ahead of any wire refusal;
  // every other non-live phase means the session is not reachable.
  const dialogs = state.snapshot.interactions ?? []
  const composerDisabled = phase !== 'live' || dialogs.length > 0
  const disabledReason =
    dialogs.length > 0
      ? 'A dialog needs an answer before prompts can send.'
      : 'The session is not reachable right now.'

  return {
    draft,
    setDraft,
    placedAbove,
    recallToEdit,
    dialogs,
    composerDisabled,
    disabledReason,
    toasts,
    pushToast,
  }
}
