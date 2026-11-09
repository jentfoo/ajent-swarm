import { useCallback, useState } from 'react'

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
// busy/error flow around fleet.launch. Presentation and the launch target stay
// with each surface.
export function useLaunchForm(): LaunchFormController {
  const [workspaceChoice, setWorkspaceChoice] = useState('')
  const [customWorkspace, setCustomWorkspace] = useState('')
  const workspace = workspaceChoice === '' ? customWorkspace : workspaceChoice

  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
