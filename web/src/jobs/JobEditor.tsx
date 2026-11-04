import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '../api/client'
import { jobsApi } from '../api/endpoints'
import type { Job, ToolState, TriggerOn } from '../api/types'
import { defaultDraft, draftFromJob, idleDelayOptions, toPayload, validateDraft } from './jobDraft'
import type { DraftErrors, JobDraft } from './jobDraft'
import {
  formatSlot,
  intervalUnits,
  scheduleKindLabels,
  weekdayTokens,
  weekdayShort,
} from './schedule'

// Permission startup flags, matching phase 04's launcher.
const permissionOptions = [
  { value: '', label: 'ajent default (asks)' },
  { value: 'read-only', label: 'read-only' },
  { value: 'allow-auto', label: 'allow-auto' },
  { value: 'allow-autowrite', label: 'allow-autowrite' },
  { value: 'allow-all', label: 'allow-all' },
]

// Timezone candidates for the daily picker; free text always works. The IANA
// list never changes within a page load, so it memoizes at module scope rather
// than rebuilding per keystroke in the editor.
let timezoneMemo: string[] | undefined
function timezoneCandidates(): string[] {
  if (timezoneMemo !== undefined) return timezoneMemo
  try {
    const zones = Intl.supportedValuesOf?.('timeZone')
    if (zones && zones.length > 0) return (timezoneMemo = [...zones])
  } catch {
    // Engines without the API answer nothing; typing a zone still works.
  }
  return (timezoneMemo = [])
}

// JobEditor is the one form for creating and editing jobs: launch facts matching
// phase 04's launcher, then trigger — schedule plus its optional pre-run
// command — prompt, missed-run policy, timeout and keep-alive. The next three
// fire times preview live through POST /api/jobs/preview, which also checks the
// workspace path.
export function JobEditor({
  job,
  seed,
  workspaces,
  models,
  toolOptions,
  onSaved,
  onCancel,
}: {
  job?: Job // editing an existing row; absent creates one
  seed?: JobDraft // pre-filled create, e.g. a duplicate of a stored row
  workspaces: string[]
  models: string[]
  toolOptions: ToolState[] // live union; may be empty when nothing serves
  onSaved: (job: Job | undefined) => void // undefined after a delete
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<JobDraft>(
    () => seed ?? (job ? draftFromJob(job) : defaultDraft()),
  )
  const errors: DraftErrors = useMemo(() => validateDraft(draft), [draft])
  const [previewTimes, setPreviewTimes] = useState<string[]>([])
  const [workspaceError, setWorkspaceError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Debounced draft preview: the backend owns scheduling semantics and checks
  // the workspace against its own filesystem; further edits abort in flight.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await jobsApi.preview(
          { ...toPayload(draft), createdAt: job?.createdAt },
          3,
          controller.signal,
        )
        setPreviewTimes(res.times)
        setWorkspaceError(res.workspaceError ?? '')
        setPreviewError('')
      } catch (err) {
        if ((err as Error | undefined)?.name === 'AbortError') return
        setPreviewError(err instanceof ApiError ? err.detail || err.message : 'Preview failed.')
      }
    }, 350)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [draft, job?.createdAt])

  const patch = (fields: Partial<JobDraft>) => setDraft((d) => ({ ...d, ...fields }))

  // Tool rows to offer: the live union first, then stored names it no longer
  // lists, so a saved custom set always stays visible and editable.
  const toolRows = useMemo(() => {
    const live = new Set(toolOptions.map((r) => r.name))
    return [
      ...toolOptions,
      ...draft.tools.filter((name) => !live.has(name)).map((name) => ({ name, source: 'stored' })),
    ]
  }, [toolOptions, draft.tools])

  const toggleTool = (name: string) =>
    patch({
      tools: draft.tools.includes(name)
        ? draft.tools.filter((n) => n !== name)
        : [...draft.tools, name],
    })

  const save = async (ev: FormEvent) => {
    ev.preventDefault()
    if (saving || Object.keys(errors).length > 0) return
    setSaving(true)
    setSaveError('')
    try {
      const saved =
        job !== undefined
          ? await jobsApi.update(job.id, toPayload(draft, job.id))
          : await jobsApi.create(toPayload(draft))
      onSaved(saved)
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Saving the job failed.')
      setSaving(false)
    }
  }

  const remove = async () => {
    if (job === undefined || saving) return
    setSaving(true)
    try {
      await jobsApi.remove(job.id)
      onSaved(undefined)
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Deleting the job failed.')
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="card modal job-editor"
        role="dialog"
        aria-label={job !== undefined ? `Edit job ${draft.name}` : 'New job'}
        onClick={(ev) => ev.stopPropagation()}
        onSubmit={save}
      >
        <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>
          {job !== undefined ? `Edit “${draft.name || 'job'}”` : 'New job'}
        </h2>

        <div className="form-grid">
          <label>
            Name
            <input
              value={draft.name}
              onChange={(ev) => patch({ name: ev.target.value })}
              aria-invalid={errors.name !== undefined}
            />
            {errors.name && <FieldError text={errors.name} />}
          </label>

          <label>
            Workspace directory
            <input
              list="job-workspaces"
              placeholder="/home/you/project"
              value={draft.workspace}
              onChange={(ev) => patch({ workspace: ev.target.value })}
              aria-invalid={errors.workspace !== undefined || workspaceError !== ''}
            />
            <datalist id="job-workspaces">
              {workspaces.map((w) => (
                <option key={w} value={w} />
              ))}
            </datalist>
            {(errors.workspace ?? workspaceError) && (
              <FieldError text={(errors.workspace ?? workspaceError)!} />
            )}
          </label>

          <label>
            Session start
            <select
              value={draft.spawnMode}
              onChange={(ev) => patch({ spawnMode: ev.target.value as JobDraft['spawnMode'] })}
            >
              <option value="new">New session</option>
              <option value="resume">Resume by id or name</option>
              <option value="continue">Continue most recent</option>
              <option value="session">Create-or-resume by name</option>
            </select>
          </label>

          {(draft.spawnMode === 'resume' || draft.spawnMode === 'session') && (
            <label>
              Session target
              <input
                placeholder={
                  draft.spawnMode === 'resume' ? '01JABC… or session-name' : 'session-name'
                }
                value={draft.sessionTarget}
                onChange={(ev) => patch({ sessionTarget: ev.target.value })}
                aria-invalid={errors.sessionTarget !== undefined}
              />
              {errors.sessionTarget && <FieldError text={errors.sessionTarget} />}
            </label>
          )}

          <label>
            Model
            <input
              list="job-models"
              placeholder="ajent default"
              value={draft.model}
              onChange={(ev) => patch({ model: ev.target.value })}
            />
            <datalist id="job-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          <label>
            Permission
            <select
              value={draft.permission}
              onChange={(ev) => patch({ permission: ev.target.value })}
            >
              {permissionOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="job-tools" role="group" aria-label="Tools">
            <span className="check-row">
              <input
                type="checkbox"
                id="job-custom-tools"
                checked={draft.customTools}
                onChange={(ev) => patch({ customTools: ev.target.checked })}
              />
              <label htmlFor="job-custom-tools">Custom tool set</label>
            </span>

            {draft.customTools && (
              <>
                {toolRows.map((row) => (
                  <label key={row.name} className="tool-row">
                    <input
                      type="checkbox"
                      checked={draft.tools.includes(row.name)}
                      onChange={() => toggleTool(row.name)}
                    />
                    <span className="switch-name">{row.name}</span>
                    <span className="muted tool-source">{row.source}</span>
                  </label>
                ))}
                {toolOptions.length === 0 && (
                  <p className="muted small-note">
                    No live session to read tool names from; the saved list still applies.
                  </p>
                )}
                {errors.tools && <FieldError text={errors.tools} />}
                <p className="muted small-note">
                  The chosen set replaces the session's defaults at launch; names this workspace
                  does not have are ignored. An empty set runs with no tools at all.
                </p>
              </>
            )}
          </div>
        </div>

        <p className="muted small-note">
          Unattended runs park at tool dialogs: jobs that must finish alone usually want allow-auto
          or allow-all.
        </p>

        <h3>Trigger</h3>
        <div className="form-grid">
          <label>
            Mode
            <select
              value={draft.scheduleKind}
              onChange={(ev) =>
                patch({ scheduleKind: ev.target.value as JobDraft['scheduleKind'] })
              }
            >
              {(Object.keys(scheduleKindLabels) as Array<keyof typeof scheduleKindLabels>).map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {scheduleKindLabels[kind]}
                  </option>
                ),
              )}
            </select>
          </label>

          {draft.scheduleKind === 'once' && (
            <label>
              Fire at
              <input
                type="datetime-local"
                value={draft.onceAt}
                onChange={(ev) => patch({ onceAt: ev.target.value })}
                aria-invalid={errors.onceAt !== undefined}
              />
              {errors.onceAt && <FieldError text={errors.onceAt} />}
            </label>
          )}

          {draft.scheduleKind === 'interval' && (
            <>
              <label>
                Every
                {/* no native min: any positive interval is valid, so the
                    draft's own validation owns the server's bounds */}
                <input
                  type="number"
                  step="any"
                  value={draft.intervalValue}
                  onChange={(ev) => patch({ intervalValue: Number(ev.target.value) })}
                  aria-invalid={errors.interval !== undefined}
                />
                {errors.interval && <FieldError text={errors.interval} />}
              </label>
              <label>
                Unit
                <select
                  value={draft.intervalUnit}
                  onChange={(ev) =>
                    patch({ intervalUnit: ev.target.value as JobDraft['intervalUnit'] })
                  }
                >
                  {intervalUnits.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {draft.scheduleKind === 'daily' && (
            <>
              <label>
                At (HH:MM)
                <input
                  placeholder="09:00"
                  value={draft.dailyTime}
                  onChange={(ev) => patch({ dailyTime: ev.target.value })}
                  aria-invalid={errors.dailyTime !== undefined}
                />
                {errors.dailyTime && <FieldError text={errors.dailyTime} />}
              </label>
              <label>
                Timezone
                <input
                  list="job-timezones"
                  placeholder="server local"
                  value={draft.tz}
                  onChange={(ev) => patch({ tz: ev.target.value })}
                />
                <datalist id="job-timezones">
                  {timezoneCandidates().map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </label>
            </>
          )}

          {draft.scheduleKind !== 'once' && (
            <div className="weekday-picker" role="group" aria-label="Days of the week">
              <span className="muted">On days</span>
              {weekdayTokens.map((token) => (
                <label key={token} className="weekday-chip">
                  <input
                    type="checkbox"
                    checked={draft.weekdays.includes(token)}
                    onChange={(ev) =>
                      patch({
                        weekdays: ev.target.checked
                          ? [...draft.weekdays, token]
                          : draft.weekdays.filter((d) => d !== token),
                      })
                    }
                  />
                  {weekdayShort[weekdayTokens.indexOf(token)]}
                </label>
              ))}
            </div>
          )}

          {draft.scheduleKind !== 'once' && (
            <label>
              Missed run
              <select
                value={draft.onMissed}
                onChange={(ev) => patch({ onMissed: ev.target.value as JobDraft['onMissed'] })}
              >
                <option value="skip">Skip and continue</option>
                <option value="fire_late">Fire once late</option>
              </select>
            </label>
          )}
        </div>

        {/* the pre-run command is part of the firing decision, so it sits inside
            the trigger block ahead of the preview and idle policy */}
        <div className="form-grid">
          <label>
            Pre-run command (optional)
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
        {draft.triggerCommand.trim() !== '' && (
          <p className="muted small-note">
            The command runs via sh -c before each fire; a non-matching outcome records the fire as
            skipped. When the job runs, its output is placed ahead of the prompt.
          </p>
        )}

        {(previewError ?? '') !== '' ? (
          <p className="error-text">{previewError}</p>
        ) : (
          previewTimes.length > 0 && (
            <div className="schedule-preview" data-testid="schedule-preview">
              <span className="muted">Next runs</span>
              <ol>
                {previewTimes.map((t, i) => (
                  <li key={i}>
                    {formatSlot(t, draft.scheduleKind === 'daily' ? draft.tz : undefined)}
                  </li>
                ))}
              </ol>
            </div>
          )
        )}

        <h3>Run when idle</h3>
        <div className="form-grid">
          <span className="check-row">
            <input
              type="checkbox"
              id="job-run-when-idle"
              checked={draft.runWhenIdle}
              onChange={(ev) => patch({ runWhenIdle: ev.target.checked })}
            />
            <label htmlFor="job-run-when-idle">
              Only start when no session has worked in the last 10 minutes
            </label>
          </span>

          {draft.runWhenIdle && (
            <label>
              If still busy, skip after waiting
              <select
                value={draft.idleMaxDelaySeconds}
                onChange={(ev) => patch({ idleMaxDelaySeconds: Number(ev.target.value) })}
              >
                {idleDelayOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <h3>Prompt</h3>
        <label className="prompt-field">
          Prompt
          <textarea
            rows={8}
            placeholder="What should ajent do on each run? Empty jobs just launch the session."
            value={draft.prompt}
            onChange={(ev) => patch({ prompt: ev.target.value })}
          />
        </label>

        <h3>Advanced</h3>
        <div className="form-grid">
          <label>
            Timeout (minutes, 0 = service default)
            <input
              type="number"
              min={0}
              value={draft.timeoutMinutes}
              onChange={(ev) => patch({ timeoutMinutes: Number(ev.target.value) })}
              aria-invalid={errors.timeoutMinutes !== undefined}
            />
            {errors.timeoutMinutes && <FieldError text={errors.timeoutMinutes} />}
          </label>

          <label>
            Overlap
            <select
              value={draft.overlap}
              onChange={(ev) => patch({ overlap: ev.target.value as JobDraft['overlap'] })}
            >
              <option value="run">Run even if the previous run is live</option>
              <option value="skip_if_running">Skip while the previous run is live</option>
            </select>
          </label>

          <span className="check-row">
            <input
              type="checkbox"
              id="job-keep-alive"
              checked={draft.keepAlive}
              onChange={(ev) => patch({ keepAlive: ev.target.checked })}
            />
            <label htmlFor="job-keep-alive">Keep the session running after each run</label>
          </span>

          <span className="check-row">
            <input
              type="checkbox"
              id="job-enabled"
              checked={draft.enabled}
              onChange={(ev) => patch({ enabled: ev.target.checked })}
            />
            <label htmlFor="job-enabled">Enabled</label>
          </span>
        </div>

        {saveError && <p className="error-text">{saveError}</p>}

        <div className="editor-actions">
          {job !== undefined && (
            <button
              type="button"
              onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              disabled={saving}
            >
              {confirmDelete ? 'Really delete?' : 'Delete…'}
            </button>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={saving || Object.keys(errors).length > 0}
          >
            {job !== undefined ? 'Save changes' : 'Create job'}
          </button>
        </div>
      </form>
    </div>
  )
}

function FieldError({ text }: { text: string }) {
  return (
    <span className="error-text field-error" role="alert">
      {text}
    </span>
  )
}
