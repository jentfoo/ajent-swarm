import { useCallback, useEffect, useRef, useState } from 'react'

import { describeError } from '../api/errors'
import { fleet } from '../api/endpoints'
import type { LaunchRequest } from '../api/types'

// LaunchTarget is the launch body a surface owns: the mode plus its optional
// target. Workspace and model come from the shared form state.
export type LaunchTarget = Pick<LaunchRequest, 'mode' | 'target'>

export interface LaunchFormController {
  workspaceChoice: string // '' reveals the custom path input
  setWorkspaceChoice: (choice: string) => void
  customWorkspace: string
  setCustomWorkspace: (path: string) => void
  workspace: string // the resolved pick: the chosen option, or the custom path
  model: string // '' rides ajent's default
  setModel: (key: string) => void
  busy: boolean
  error: string
  // launch posts one request built from the form state, it resolves the new
  // session id, or null with the error already surfaced. Busy holds through a
  // success because every caller navigates away on it.
  launch: (target: LaunchTarget) => Promise<string | null>
}

// useLaunchForm is the launch facts form body every launcher surface shares:
// the workspace select with its custom-path reveal, the model select, and the
// busy/error flow around fleet.launch. The most recent of the workspace
// options seeds the choice once, and only while the form still sits at its
// untouched empty state, so late options never overwrite a user edit.
// Presentation and the launch target stay with each surface.
export function useLaunchForm(workspaceOptions: string[]): LaunchFormController {
  const [workspaceChoice, setWorkspaceChoiceState] = useState('')
  const [customWorkspace, setCustomWorkspaceState] = useState('')
  const workspace = workspaceChoice === '' ? customWorkspace : workspaceChoice

  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The default applies before any user edit: a touched form keeps its state
  // whatever arrives later. The effect keys on the path value itself, so a
  // refreshed options array never re-runs it.
  const touchedRef = useRef(false)
  const seededRef = useRef(false)
  const recent = workspaceOptions[0]
  useEffect(() => {
    if (seededRef.current || touchedRef.current || recent === undefined) return
    seededRef.current = true
    setWorkspaceChoiceState(recent)
  }, [recent])

  const setWorkspaceChoice = useCallback((choice: string) => {
    touchedRef.current = true
    setWorkspaceChoiceState(choice)
  }, [])
  const setCustomWorkspace = useCallback((path: string) => {
    touchedRef.current = true
    setCustomWorkspaceState(path)
  }, [])

  const launch = useCallback(
    async (target: LaunchTarget): Promise<string | null> => {
      if (busy) return null
      const workspaceTrimmed = workspace.trim()
      if (workspaceTrimmed === '') {
        setError('Pick the working directory to start under.')
        return null
      }
      setBusy(true)
      setError('')
      try {
        const res = await fleet.launch({
          ...target,
          workspace: workspaceTrimmed,
          model: model.trim() === '' ? undefined : model,
        })
        return res.sessionId
      } catch (err) {
        setBusy(false)
        setError(describeError(err, 'Launch failed.'))
        return null
      }
    },
    [busy, workspace, model],
  )

  return {
    workspaceChoice,
    setWorkspaceChoice,
    customWorkspace,
    setCustomWorkspace,
    workspace,
    model,
    setModel,
    busy,
    error,
    launch,
  }
}
