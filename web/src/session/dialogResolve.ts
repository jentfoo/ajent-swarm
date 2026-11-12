import { useCallback, useState } from 'react'

import { ApiError } from '../api/client'
import { describeError } from '../api/errors'
import { sessions } from '../api/endpoints'
import type { ResolveAnswer } from '../api/types'

// DialogAnswer is one answer body without its dialog id, the resolve hook owns
// that, so callers never repeat it per control.
type DialogAnswer = Omit<ResolveAnswer, 'dialogId'>

interface DialogResolve {
  busy: boolean
  error: string
  // resolve posts one answer for this dialog, a busy card answers nothing;
  // true when the answer lands or settled benignly, false on a refusal so a
  // caller can keep its draft
  resolve: (body: DialogAnswer) => Promise<boolean>
}

// useDialogResolve is one dialog card's answer state, shared by every dock:
// busy while a resolve is in flight, the refusal message on failure, and the
// settled-tolerant post itself. onAnsweredLocally fires at submission, ahead
// of the post's response and the stream's settled frame, so an own answer
// never reads as answered elsewhere; a failed resolve leaves the card
// standing for another try.
export function useDialogResolve(
  sessionId: string,
  dialogId: number,
  onAnsweredLocally: (dialogId: number) => void,
): DialogResolve {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const resolve = useCallback(
    async (body: DialogAnswer): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      setError('')
      // ownership rides the submit, not the response: the settled frame takes
      // the stream and can land first
      onAnsweredLocally(dialogId)
      try {
        await sessions.resolve(sessionId, { ...body, dialogId })
        return true
      } catch (err) {
        // settled is benign: another surface's answer already won
        if (!(err instanceof ApiError && err.code === 'settled')) {
          setError(describeError(err, 'Resolve failed.'))
          return false
        }
        return true
      } finally {
        setBusy(false)
      }
    },
    [busy, sessionId, dialogId, onAnsweredLocally],
  )

  return { busy, error, resolve }
}
