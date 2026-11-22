import type { ReactElement } from 'react'

import { QueueFields, queueSubmitLabel } from '../workspace/QueueFields'
import { useQueueFollowForm } from '../workspace/useQueueFollowForm'
import { useWorkspace } from '../providers/workspace'
import { PushedScreen } from './PushedScreen'
import type { QueueDraft } from '../providers/workspace'

// QueueScreen is the mobile shell of the shared follow-up form: the workspace
// draft rendered as a pushed screen, so platform back and the overlay stack
// treat it like every other mobile layer. The dirty guard confirms before
// dropping typed prompts, the same contract the desktop modal's shell keeps.
// The body mounts only while a draft is open, so the launch-facts reads
// behind it wait for real use. Null while no draft is open.
export function QueueScreen(): ReactElement | null {
  const { queueDraft, setQueueDraft } = useWorkspace()
  if (queueDraft === null) return null
  return <QueueScreenBody draft={queueDraft} onClose={() => setQueueDraft(null)} />
}

function QueueScreenBody({ draft, onClose }: { draft: QueueDraft; onClose: () => void }) {
  const form = useQueueFollowForm(draft, onClose)

  return (
    <PushedScreen
      title={`Queue follow up after ${form.parentName}`}
      dirty={form.dirty || undefined}
      onClose={() => {
        if (!form.saving) onClose()
      }}
    >
      <div className="settings-screen-body">
        <QueueFields
          form={form}
          footer={
            <div className="editor-actions">
              <span className="spacer" style={{ flex: 1 }} />
              <button className="primary" type="submit" disabled={form.saving}>
                {form.saving ? 'Queueing…' : queueSubmitLabel()}
              </button>
            </div>
          }
        />
      </div>
    </PushedScreen>
  )
}
