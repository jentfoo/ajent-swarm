import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { prependDraft, readDraft, writeDraft } from './draftStore'

// placedAboveNotice names a prefill that merged above existing text; views
// surface it so an arrival above the draft is noticed (composer-draft-policy).
export const placedAboveNotice = 'Placed above your existing draft.'

export interface ComposerDraft {
  draft: string
  // setDraft applies one edit and writes through to storage.
  setDraft: (text: string) => void
  // prefill places rewound or recalled text under the prepend rule, returning
  // whether it merged above a non-empty draft; empty text is ignored.
  prefill: (text: string) => boolean
}

// useComposerDraft owns one session's composer text with the persistence and
// prefill rules of composer-draft-policy.md. Hosts reuse the view across
// sessionId swaps, so each swap loads that session's own draft before paint.
export function useComposerDraft(sessionId: string): ComposerDraft {
  const [draft, setDraftState] = useState(() => readDraft(sessionId))
  // ref mirror keeps prefill off a stale closure across same-tick calls
  const currentRef = useRef(draft)

  const setDraft = useCallback(
    (text: string) => {
      currentRef.current = text
      setDraftState(text)
      writeDraft(sessionId, text)
    },
    [sessionId],
  )

  useLayoutEffect(() => {
    const stored = readDraft(sessionId)
    if (currentRef.current !== stored) setDraft(stored)
  }, [sessionId, setDraft])

  const prefill = useCallback(
    (incoming: string): boolean => {
      if (incoming === '') return false
      const current = currentRef.current
      setDraft(prependDraft(current, incoming))
      return current !== ''
    },
    [setDraft],
  )

  return { draft, setDraft, prefill }
}
