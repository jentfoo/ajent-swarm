import { useMemo, useState } from 'react'

import { ApiError } from '../api/client'
import { describeError } from '../api/errors'
import { fleet, sessions as sessionAPI } from '../api/endpoints'
import { chainPreview } from './useChainForm'
import { childEnded } from '../api/types'
import { useLaunchFacts } from '../hooks/useLaunchFacts'
import { useSessionNamer } from '../session/useSessionLabel'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import type { Chain, ModelState } from '../api/types'
import type { QueueDraft } from '../providers/workspace'

// The one follow-up form model behind both shells: the desktop modal and the
// mobile pushed screen render the same fields, preview and submit path, so
// queueing a new session behind a running one never drifts between surfaces.

// attachRetryMs paces the create re-asks while the fresh child attaches.
const attachRetryMs = 100
// attachRetries bounds them: Launch answers once the child serves, its actor
// route lands one watch beat later, and that beat can span the two calls.
const attachRetries = 20

// chainAfterLaunch posts the chain create, re-asking briefly while the just
// launched child is still joining the fleet's route table. Every other
// refusal surfaces immediately.
async function chainAfterLaunch(
  parentId: string,
  childId: string,
  prompts: { finalPrompt: string; childPrompt: string },
): Promise<Chain> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sessionAPI.chain(parentId, { childId, ...prompts })
    } catch (err) {
      const fresh = err instanceof ApiError && err.code === 'session_not_found'
      if (!fresh || attempt >= attachRetries) throw err
      await new Promise((resolve) => setTimeout(resolve, attachRetryMs))
    }
  }
}

export interface QueueFollowForm {
  parentName: string
  // stored as the child's display title at submit, empty names it from the
  // start prompt through the one-shot labeler
  name: string
  setName: (v: string) => void
  finalPrompt: string
  setFinalPrompt: (v: string) => void
  startPrompt: string
  setStartPrompt: (v: string) => void
  // launch facts for the follow-up session, the shared launch form fields
  workspaceChoice: string
  setWorkspaceChoice: (choice: string) => void
  customWorkspace: string
  setCustomWorkspace: (path: string) => void
  workspaceOptions: string[]
  models: ModelState[]
  model: string
  setModel: (key: string) => void
  dirty: boolean
  saving: boolean
  error: string
  preview: string
  submit: () => Promise<void>
}

// useQueueFollowForm drives one follow-up draft: the optional final prompt
// runs on the parent, the required start prompt rides the new session's
// handoff line. Submit launches the session into the picked workspace, then
// queues it behind the parent. onDone fires after both calls land.
export function useQueueFollowForm(draft: QueueDraft | null, onDone: () => void): QueueFollowForm {
  const { sessions, refreshSessions, refreshAttention } = useSwarm()
  const { rememberChain } = useWorkspace()
  const nameFor = useSessionNamer()
  const facts = useLaunchFacts()

  const [name, setName] = useState('')
  const [finalPrompt, setFinalPrompt] = useState('')
  const [startPrompt, setStartPrompt] = useState('')
  const [workspaceChoice, setWorkspaceChoice] = useState('')
  const [customWorkspace, setCustomWorkspace] = useState('')
  const [model, setModel] = useState('')
  const [initialWorkspace, setInitialWorkspace] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // seen starts null so a first draft already riding the mount prefills too
  const [seenDraft, setSeenDraft] = useState<QueueDraft | null>(null)

  // fields reset per draft through the render-time prop-change pattern: a
  // shell stays mounted while sessions swap beneath it
  if (draft !== seenDraft) {
    setSeenDraft(draft)
    if (draft !== null) {
      setName('')
      setFinalPrompt('')
      setStartPrompt('')
      // the follow-up continues in the parent's directory by default
      const parent = sessions.find((s) => s.sessionId === draft.parentId)
      const parentWorkspace = parent?.workspace ?? ''
      setWorkspaceChoice('')
      setCustomWorkspace(parentWorkspace)
      setInitialWorkspace(parentWorkspace)
    }
    setError('')
  }

  const parentName = draft === null ? '' : nameFor(draft.parentId)
  const workspace = workspaceChoice === '' ? customWorkspace : workspaceChoice
  const trimmedStart = startPrompt.trim()
  const preview = useMemo(
    () => (draft === null ? '' : chainPreview(parentName, trimmedStart, finalPrompt.trim())),
    [draft, parentName, trimmedStart, finalPrompt],
  )

  const submit = async () => {
    if (draft === null || saving) return
    if (trimmedStart === '') {
      setError('Write the start prompt the follow-up session begins with.')
      return
    }
    const ws = workspace.trim()
    if (ws === '') {
      setError('Pick the working directory the follow-up session starts under.')
      return
    }
    // refuse the obvious loss early: a parent the roster shows ended cannot
    // hand off, and the child would launch into an orphaned wait otherwise
    const parent = sessions.find((s) => s.sessionId === draft.parentId)
    if (parent !== undefined && childEnded(parent.state)) {
      setError(`${parentName} is no longer running, it cannot hand off.`)
      return
    }
    setSaving(true)
    setError('')
    let launched: string | undefined
    try {
      const res = await fleet.launch({
        mode: 'new',
        workspace: ws,
        model: model.trim() === '' ? undefined : model,
      })
      launched = res.sessionId
      // the stored title wins over the auto-namer, so a name typed here labels
      // the idle child from the moment it joins the roster
      const trimmedName = name.trim()
      if (trimmedName !== '') {
        await sessionAPI.setTitle(res.sessionId, trimmedName)
      }
      const chain = await chainAfterLaunch(draft.parentId, res.sessionId, {
        finalPrompt: finalPrompt.trim(),
        childPrompt: trimmedStart,
      })
      rememberChain(chain)
      onDone()
      void refreshSessions()
      void refreshAttention()
    } catch (err) {
      // a launched child with no chain is an orphaned idle session, so a
      // failed follow-up stops the session it just created
      let stopped = true
      if (launched !== undefined) {
        try {
          await sessionAPI.stop(launched)
        } catch {
          stopped = false
        }
      }
      const detail = describeError(err, 'Queueing the follow-up session failed.')
      setError(
        launched !== undefined && stopped
          ? `${detail} The new session was stopped.`
          : launched !== undefined
            ? `${detail} Stopping the new session failed, stop it from the roster.`
            : detail,
      )
    } finally {
      setSaving(false)
    }
  }

  return {
    parentName,
    name,
    setName,
    finalPrompt,
    setFinalPrompt,
    startPrompt,
    setStartPrompt,
    workspaceChoice,
    setWorkspaceChoice,
    customWorkspace,
    setCustomWorkspace,
    workspaceOptions: facts.workspaceOptions,
    models: facts.models,
    model,
    setModel,
    dirty:
      name !== '' ||
      finalPrompt !== '' ||
      startPrompt !== '' ||
      workspaceChoice !== '' ||
      customWorkspace.trim() !== initialWorkspace ||
      model !== '',
    saving,
    error,
    preview,
    submit,
  }
}
