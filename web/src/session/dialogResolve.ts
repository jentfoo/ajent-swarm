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
  // resolve posts one answer for this dialog, a busy card answers nothing
  resolve: (body: DialogAnswer) => Promise<void>
}

// useDialogResolve is one dialog card's answer state, shared by every dock:
// busy while a resolve is in flight, the refusal message on failure, and the
// settled-tolerant post itself. A landed answer reports through
// onAnsweredLocally so the caller clears its card.
export function useDialogResolve(
  sessionId: string,
  dialogId: number,
  onAnsweredLocally: (dialogId: number) => void,
): DialogResolve {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const resolve = useCallback(
    async (body: DialogAnswer) => {
      if (busy) return
      setBusy(true)
      setError('')
      try {
        await sessions.resolve(sessionId, { ...body, dialogId })
      } catch (err) {
        // settled is benign: another surface's answer already won
        if (!(err instanceof ApiError && err.code === 'settled')) {
          setError(describeError(err, 'Resolve failed.'))
          return
        }
      } finally {
        setBusy(false)
      }
      onAnsweredLocally(dialogId)
    },
    [busy, sessionId, dialogId, onAnsweredLocally],
  )

  return { busy, error, resolve }
}
