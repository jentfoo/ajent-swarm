import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { describeError } from '../api/errors'
import { jobsApi } from '../api/endpoints'
import type { Job, ToolState } from '../api/types'
import { defaultDraft, draftsEqual, validateDraft } from './jobDraft'
import type { DraftErrors, JobDraft } from './jobDraft'
import { TriggerCommandFields } from './TriggerCommandFields'
import { FieldError, JobFactsFields } from './JobFactsFields'
import { ModalShell } from '../ui/ModalShell'

// QueueComposer is the short form behind the Queue action: one prompt parked
// until no session has been active for ten minutes, then run once in a fresh
// session that stays open for review. Launch facts render through the block
// the job editor shares, the fixed policy reads as quiet text since the
// server owns it.
export function QueueComposer({
  workspaces,
  models,
  toolOptions,
  onQueued,
  onCancel,
}: {
  workspaces: string[]
  models: string[]
  toolOptions: ToolState[] // live union; may be empty when nothing serves
  onQueued: (job: Job) => void
  onCancel: () => void
}) {
  // source pins the untouched form: edits make the discard guard ask first
  const [source] = useState(defaultDraft)
  const [draft, setDraft] = useState<JobDraft>(source)
  // the queue always wants a prompt, unlike the editor's optional one
  const errors: DraftErrors = useMemo(() => {
    const found = validateDraft(draft)
    if (draft.prompt.trim() === '') found.prompt = 'Prompt is required.'
    return found
  }, [draft])
  // true once a close would lose typed content
  const dirty = !draftsEqual(draft, source)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const patch = (fields: Partial<JobDraft>) => setDraft((d) => ({ ...d, ...fields }))

  const save = async (ev: FormEvent) => {
    ev.preventDefault()
    if (saving || Object.keys(errors).length > 0) return
    setSaving(true)
    setSaveError('')
    try {
      const job = await jobsApi.queue({
        name: draft.name.trim(),
        workspace: draft.workspace.trim(),
        prompt: draft.prompt,
        model: draft.model.trim(),
        permission: draft.permission,
        toolsCustom: draft.customTools,
        // the server clears the stored list when custom is off, like the editor
        tools: draft.customTools ? draft.tools.join(',') : '',
        triggerCommand: draft.triggerCommand,
        triggerOn: draft.triggerOn,
      })
      onQueued(job)
    } catch (err) {
      setSaveError(describeError(err, 'Queuing the prompt failed.'))
      setSaving(false)
    }
  }

  return (
    <ModalShell
      label="Queue a prompt"
      className="job-editor"
      showClose
      dirty={dirty}
      onClose={onCancel}
    >
      <form onSubmit={save}>
        <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>Queue a prompt</h2>

        <div className="form-grid">
          <JobFactsFields
            draft={draft}
            patch={patch}
            errors={errors}
            workspaces={workspaces}
            models={models}
            toolOptions={toolOptions}
          />
        </div>

        <h3>Prompt</h3>
        <label className="prompt-field">
          Prompt
          <textarea
            rows={8}
            placeholder="What should ajent do once the fleet is idle?"
            value={draft.prompt}
            onChange={(ev) => patch({ prompt: ev.target.value })}
            aria-invalid={errors.prompt !== undefined}
          />
          {errors.prompt && <FieldError text={errors.prompt} />}
        </label>

        <h3>Pre-run command (optional)</h3>
        <TriggerCommandFields draft={draft} patch={patch} errors={errors} label="Pre-run command" />

        <p className="muted small-note">
          Runs in a new session once no session has been active for 10 minutes; the session stays
          open afterwards. Delete the row to cancel while it waits.
        </p>

        {saveError && <p className="error-text">{saveError}</p>}

        <div className="editor-actions">
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={saving || Object.keys(errors).length > 0}
          >
            Queue prompt
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
