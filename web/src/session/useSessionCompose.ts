import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { InteractionPending } from '../api/types'
import { useToasts } from '../hooks/useToasts'
import type { ToastView } from '../hooks/useToasts'
import { useSessionChannel } from '../hooks/useSessionChannel'
import { mergeRecallSources, maxRecallPrompts, recallPrompts } from '../state/derive'
import type { RecallPrompt } from '../state/derive'
import type { ComposerRecall } from './Composer'
import { prependDraft } from './draftStore'
import { placedAboveNotice, useComposerDraft } from './useComposerDraft'

interface SessionCompose {
  draft: string
  // setDraft applies one edit and writes through to storage.
  setDraft: (text: string) => void
  // placedAbove places text under the prepend rule, announcing a merge above
  // an existing draft with a toast.
  placedAbove: (text: string) => void
  // recall wires the composer's prompt recall: items merge the session's
  // committed typed prompts with the workspace-wide mirror, accept lands a
  // match under the prepend rule, and refresh re-reads the mirror.
  recall: ComposerRecall
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

  // The workspace-wide recall mirror, best effort: a failed read just leaves
  // the session-local source serving, and a session swap remounts this hook's
  // host so the mirror starts empty again. One fetch in flight, so a refresh
  // landing late cannot be overwritten by the older reply it superseded.
  const [workspaceLines, setWorkspaceLines] = useState<RecallPrompt[]>([])
  const recallReq = useRef<AbortController | null>(null)
  const fetchWorkspaceRecall = useCallback(() => {
    recallReq.current?.abort()
    const controller = new AbortController()
    recallReq.current = controller
    sessionAPI
      .recallLines(sessionId, '', maxRecallPrompts, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return
        setWorkspaceLines(
          (res.items ?? []).map((row) => {
            const ts = Date.parse(row.createdAt)
            return { text: row.text, ts: Number.isFinite(ts) ? ts : 0 }
          }),
        )
      })
      .catch(() => {}) // aborted or failed: the local source still serves
  }, [sessionId])
  useEffect(() => {
    fetchWorkspaceRecall()
    return () => recallReq.current?.abort()
  }, [fetchWorkspaceRecall])

  // placedAbove surfaces a prefill that merged above an existing draft, so the
  // arrival is noticed instead of reading as one's own text moving down.
  const placedAbove = useCallback(
    (text: string) => {
      if (prefill(text)) pushToast(placedAboveNotice)
    },
    [prefill, pushToast],
  )

  // recallAccept lands an accepted history-search match through the same
  // prepend-with-notice rule a rewind prefill takes, so an existing draft is
  // never clobbered; the returned draft lets the composer place its caret.
  const recallAccept = useCallback(
    (text: string, current: string): string => {
      const next = prependDraft(current, text)
      setDraft(next)
      if (current !== '') pushToast(placedAboveNotice)
      return next
    },
    [setDraft, pushToast],
  )
  // The source merges the session's committed prompts with the workspace
  // recall mirror, one newest-first order; it re-derives with the chain, the
  // same trigger the transcript's own block derivation uses, and whenever a
  // mirror fetch lands.
  const recall = useMemo(
    () => ({
      items: mergeRecallSources(recallPrompts(state.chain.ids, state.entries), workspaceLines),
      accept: recallAccept,
      refresh: fetchWorkspaceRecall,
    }),
    [state.chain, state.entries, recallAccept, workspaceLines, fetchWorkspaceRecall],
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
    recall,
    recallToEdit,
    dialogs,
    composerDisabled,
    disabledReason,
    toasts,
    pushToast,
  }
}
