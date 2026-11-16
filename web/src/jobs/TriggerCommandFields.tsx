import type { TriggerOn } from '../api/types'
import { FieldError } from './JobFactsFields'
import type { DraftErrors, JobDraft } from './jobDraft'

// TriggerCommandFields renders the pre-run command block both job forms
// share: the command input and, once a command is set, the outcome select.
// patch applies partial draft edits.
export function TriggerCommandFields({
  draft,
  patch,
  errors,
  label,
}: {
  draft: JobDraft
  patch: (fields: Partial<JobDraft>) => void
  errors: DraftErrors
  label: string
}) {
  return (
    <div className="form-grid">
      <label>
        {label}
        <input
          placeholder="e.g. git pull --ff-only"
          value={draft.triggerCommand}
          onChange={(ev) => patch({ triggerCommand: ev.target.value })}
          aria-invalid={errors.triggerCommand !== undefined}
        />
        {errors.triggerCommand && <FieldError text={errors.triggerCommand} />}
      </label>

      {draft.triggerCommand.trim() !== '' && (
        <label>
          Run the job when the command
          <select
            value={draft.triggerOn}
            onChange={(ev) => patch({ triggerOn: ev.target.value as TriggerOn })}
          >
            <option value="success">Succeeds (exit zero)</option>
            <option value="error">Errors (non-zero exit)</option>
          </select>
        </label>
      )}
    </div>
  )
}
