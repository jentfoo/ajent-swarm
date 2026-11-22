import { useQueueFollowForm } from './useQueueFollowForm'
import { QueueFields, queueSubmitLabel } from './QueueFields'
import { ModalCancelButton, ModalShell } from '../ui/ModalShell'
import { useWorkspace } from '../providers/workspace'
import type { QueueDraft } from '../providers/workspace'

// QueueDialog is the desktop shell of the shared follow-up form: one modal
// per workspace so session view remounts never kill it mid-edit. The session
// context menu and the settings menu entry open it through the workspace
// provider's queue draft. The body mounts only while a draft is open, so the
// launch-facts reads behind it wait for real use.
export function QueueDialog() {
  const { queueDraft, setQueueDraft } = useWorkspace()
  if (queueDraft === null) return null
  return <QueueDialogBody draft={queueDraft} onClose={() => setQueueDraft(null)} />
}

function QueueDialogBody({ draft, onClose }: { draft: QueueDraft; onClose: () => void }) {
  const form = useQueueFollowForm(draft, onClose)

  return (
    <ModalShell
      label={`Queue follow up session after ${form.parentName}`}
      className="chain-dialog"
      showClose
      dirty={form.dirty || undefined}
      onClose={() => {
        if (!form.saving) onClose()
      }}
    >
      <QueueFields
        form={form}
        footer={
          <div className="editor-actions">
            <span className="spacer" style={{ flex: 1 }} />
            <ModalCancelButton disabled={form.saving} />
            <button className="primary" type="submit" disabled={form.saving}>
              {form.saving ? 'Queueing…' : queueSubmitLabel()}
            </button>
          </div>
        }
      />
    </ModalShell>
  )
}
