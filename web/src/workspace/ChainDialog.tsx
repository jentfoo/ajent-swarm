import { useChainForm } from './useChainForm'
import { ChainFields, chainSubmitLabel } from './ChainFields'
import { ModalCancelButton, ModalShell } from '../ui/ModalShell'
import { useWorkspace } from '../providers/workspace'

// ChainDialog is the desktop shell of the shared chain form: one modal per
// workspace so session view remounts never kill it mid-edit. The drop
// gestures and the settings menu entry open it through the workspace
// provider's chain draft.
export function ChainDialog() {
  const { chainDraft, setChainDraft } = useWorkspace()
  const form = useChainForm(chainDraft, () => setChainDraft(null))

  if (chainDraft === null) return null

  return (
    <ModalShell
      label={`Chain ${form.childName} after ${form.parentName}`}
      className="chain-dialog"
      showClose
      dirty={form.dirty || undefined}
      onClose={() => {
        if (!form.saving) setChainDraft(null)
      }}
    >
      <ChainFields
        form={form}
        footer={
          <div className="editor-actions">
            <span className="spacer" style={{ flex: 1 }} />
            <ModalCancelButton disabled={form.saving} />
            <button className="primary" type="submit" disabled={form.saving}>
              {chainSubmitLabel(form.editing, form.saving)}
            </button>
          </div>
        }
      />
    </ModalShell>
  )
}
