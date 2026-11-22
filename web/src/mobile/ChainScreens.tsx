import type { ReactElement } from 'react'

import { ChainTargets, chainPickerIntro } from '../workspace/ChainPicker'
import { ChainFields, chainSubmitLabel } from '../workspace/ChainFields'
import { useChainForm } from '../workspace/useChainForm'
import { useWorkspace } from '../providers/workspace'
import { PushedScreen } from './PushedScreen'

// ChainPickerScreen is the pushed target picker behind "Chain after…": one
// full-screen list of the sessions a chain may deliver into, picking one
// lands the shared chain draft and the editor screen takes over. The leading
// row starts a fresh session instead, landing the follow-up form with this
// session as its parent.
export function ChainPickerScreen({
  parentId,
  onPick,
  onQueueNew,
  onClose,
}: {
  parentId: string
  onPick: (childId: string) => void
  onQueueNew?: () => void
  onClose: () => void
}): ReactElement {
  return (
    <PushedScreen title="Chain after this session" onClose={onClose}>
      <div className="settings-screen-body">
        <p className="muted">{chainPickerIntro}</p>
        {onQueueNew && (
          <div className="chain-targets" role="list" aria-label="Chain target sessions">
            <button type="button" role="listitem" className="chain-target-row" onClick={onQueueNew}>
              <span className="rail-name">Start a new session…</span>
            </button>
          </div>
        )}
        <ChainTargets parentId={parentId} onPick={onPick} showEmpty={onQueueNew === undefined} />
      </div>
    </PushedScreen>
  )
}

// ChainEditorScreen is the mobile shell of the shared chain form: the
// workspace draft rendered as a pushed screen, so platform back and the
// overlay stack treat it like every other mobile layer. The dirty guard
// confirms before dropping typed prompts, the same contract the desktop
// modal's shell keeps. Null while no draft is open.
export function ChainEditorScreen(): ReactElement | null {
  const { chainDraft, setChainDraft } = useWorkspace()
  const form = useChainForm(chainDraft, () => setChainDraft(null))

  if (chainDraft === null) return null
  return (
    <PushedScreen
      title={`Chain ${form.childName} after ${form.parentName}`}
      dirty={form.dirty || undefined}
      onClose={() => {
        if (!form.saving) setChainDraft(null)
      }}
    >
      <div className="settings-screen-body">
        <ChainFields
          form={form}
          footer={
            <div className="editor-actions">
              <span className="spacer" style={{ flex: 1 }} />
              <button className="primary" type="submit" disabled={form.saving}>
                {chainSubmitLabel(form.editing, form.saving)}
              </button>
            </div>
          }
        />
      </div>
    </PushedScreen>
  )
}
