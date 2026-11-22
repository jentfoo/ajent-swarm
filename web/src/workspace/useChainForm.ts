import { useMemo, useState } from 'react'

import { describeError } from '../api/errors'
import { chainsApi, sessions as sessionAPI } from '../api/endpoints'
import type { Chain } from '../api/types'
import { composeChainedLine } from '../state/derive'
import { useSessionNamer } from '../session/useSessionLabel'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import type { ChainDraft } from '../providers/workspace'

// The one chain form model behind both shells: the desktop modal and the
// mobile pushed screen render the same fields, preview and submit path, so
// validation and the composed line can never drift between surfaces.

// defaultChildPrompt is the continuation line an empty prompt resolves to.
// It rides the preview and the submit verbatim, never a silent substitution.
export function defaultChildPrompt(parentName: string): string {
  return `Continue from where ${parentName} left off.`
}

// chainPreview composes the line the child receives: behind a final prompt
// the sentinel-wrapped answer to that prompt rides above the child prompt,
// without one the child runs the prompt alone. The answer is future work, so
// the preview always states its placeholder rather than quoting the parent's
// current latest response, which the chain never forwards.
export function chainPreview(parentName: string, childPrompt: string, finalPrompt: string): string {
  const prompt = childPrompt === '' ? defaultChildPrompt(parentName) : childPrompt
  if (finalPrompt.trim() === '') return prompt
  return composeChainedLine('…the final prompt\u2019s answer rides here once it finishes…', prompt)
}

export interface ChainForm {
  parentName: string
  childName: string
  editing: boolean
  finalRunning: boolean
  finalPrompt: string
  setFinalPrompt: (v: string) => void
  childPrompt: string
  setChildPrompt: (v: string) => void
  dirty: boolean
  saving: boolean
  error: string
  preview: string
  effectivePrompt: string
  submit: () => Promise<void>
}

// useChainForm drives one chain draft: fields reset per draft, the preview
// reads the parent's latest assistant response best-effort, and submit sends
// the effective prompt (the typed one, else the visible default line).
// onDone fires after a successful create or edit.
export function useChainForm(draft: ChainDraft | null, onDone: () => void): ChainForm {
  const { rememberChain } = useWorkspace()
  const { refreshAttention } = useSwarm()
  const nameFor = useSessionNamer()

  const editing = draft?.chain
  const finalRunning = editing?.state === 'final'
  const [finalPrompt, setFinalPrompt] = useState('')
  const [childPrompt, setChildPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // seen starts null so a first draft already riding the mount prefills too
  const [seenDraft, setSeenDraft] = useState<ChainDraft | null>(null)

  // fields reset per draft through the render-time prop-change pattern: a
  // shell stays mounted while sessions swap beneath it
  if (draft !== seenDraft) {
    setSeenDraft(draft)
    if (draft !== null) {
      setFinalPrompt(draft.chain?.finalPrompt ?? '')
      setChildPrompt(draft.chain?.childPrompt ?? '')
    }
    setError('')
  }

  const parentName = draft === null ? '' : nameFor(draft.parentId)
  const childName = draft === null ? '' : nameFor(draft.childId)
  const trimmedChild = childPrompt.trim()
  const effectivePrompt =
    trimmedChild === '' && draft !== null ? defaultChildPrompt(parentName) : trimmedChild
  const preview = useMemo(
    () => (draft === null ? '' : chainPreview(parentName, trimmedChild, finalPrompt.trim())),
    [draft, parentName, trimmedChild, finalPrompt],
  )

  const submit = async () => {
    if (draft === null || saving) return
    setSaving(true)
    setError('')
    try {
      // a running final prompt is immutable, its recorded value rides the edit
      const nextFinal = finalRunning ? (editing?.finalPrompt ?? '') : finalPrompt.trim()
      let chain: Chain
      if (editing !== undefined) {
        chain = await chainsApi.update(editing.id, {
          finalPrompt: nextFinal,
          childPrompt: effectivePrompt,
        })
      } else {
        chain = await sessionAPI.chain(draft.parentId, {
          childId: draft.childId,
          finalPrompt: nextFinal,
          childPrompt: effectivePrompt,
        })
      }
      rememberChain(chain)
      onDone()
      void refreshAttention()
    } catch (err) {
      setError(describeError(err, 'Chaining the sessions failed.'))
    } finally {
      setSaving(false)
    }
  }

  return {
    parentName,
    childName,
    editing: editing !== undefined,
    finalRunning,
    finalPrompt,
    setFinalPrompt,
    childPrompt,
    setChildPrompt,
    dirty:
      (!finalRunning && finalPrompt !== (editing?.finalPrompt ?? '')) ||
      childPrompt !== (editing?.childPrompt ?? ''),
    saving,
    error,
    preview,
    effectivePrompt,
    submit,
  }
}
