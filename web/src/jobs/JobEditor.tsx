import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { describeError } from '../api/errors'
import { jobsApi } from '../api/endpoints'
import type { Job, ToolState } from '../api/types'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import {
  defaultDraft,
  draftsEqual,
  draftFromJob,
  idleDelayOptions,
  scheduleValid,
  toPayload,
  validateDraft,
} from './jobDraft'
import type { DraftErrors, JobDraft } from './jobDraft'
import { TriggerCommandFields } from './TriggerCommandFields'
import { FieldError, JobFactsFields } from './JobFactsFields'
import {
  formatSlot,
  intervalUnits,
  scheduleKindLabels,
  weekdayTokens,
  weekdayShort,
} from './schedule'
import { ModalCancelButton, ModalShell } from '../ui/ModalShell'

// Timezone candidates for the daily picker, free text always works. The IANA
// list never changes within a page load, so it memoizes at module scope rather
// than rebuilding per keystroke in the editor.
let timezoneMemo: string[] | undefined
function timezoneCandidates(): string[] {
  if (timezoneMemo !== undefined) return timezoneMemo
  try {
    const zones = Intl.supportedValuesOf?.('timeZone')
    if (zones && zones.length > 0) return (timezoneMemo = [...zones])
  } catch {
    // Engines without the API answer nothing, typing a zone still works.
  }
  return (timezoneMemo = [])
}

// JobEditor is the one form for creating and editing jobs: launch facts
// mirroring the launcher, then trigger (schedule plus its optional pre-run
// command), prompt, missed-run policy, timeout and keep-alive. The next three
// fire times preview live through POST /api/jobs/preview once the draft's
// schedule fields pass local validation, and that call checks the workspace.
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
  // source pins what this mount opened with: the discard guard compares typed
  // content against it, so poll refreshes of the stored row never tip it, and
  // a duplicate seed opens clean until something is actually typed
  const [source] = useState<JobDraft>(() => seed ?? (job ? draftFromJob(job) : defaultDraft()))
  const [draft, setDraft] = useState(source)
  const errors: DraftErrors = useMemo(() => validateDraft(draft), [draft])
  // true once a close would lose typed content
  const dirty = !draftsEqual(draft, source)
  const [previewTimes, setPreviewTimes] = useState<string[]>([])
  const [workspaceError, setWorkspaceError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  // the schedule's own fields must pass local validation before a preview may ask
  const scheduleOk = scheduleValid(draft)

  // Debounced draft preview: the backend owns scheduling semantics and checks
  // the workspace against its own filesystem, further edits abort in flight.
  // A draft that turns invalid drops its results on the same tick instead of a
  // synchronous effect-body clear, so stale slots never outlive their fields.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(
      async () => {
        if (!scheduleOk) {
          setPreviewTimes([])
          setWorkspaceError('')
          setPreviewError('')
          return
        }
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
          setPreviewError(describeError(err, 'Preview failed.'))
        }
      },
      scheduleOk ? 350 : 0,
    )
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [draft, job?.createdAt, scheduleOk])

  const patch = (fields: Partial<JobDraft>) => setDraft((d) => ({ ...d, ...fields }))

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
      setSaveError(describeError(err, 'Saving the job failed.'))
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
      setSaveError(describeError(err, 'Deleting the job failed.'))
      setSaving(false)
    }
  }

  // no resetKey: the jobs poll rebuilds row objects every load, so an object
  // key would void the arm mid-window, route swaps remount this form disarmed
  const confirm = useArmedConfirm(() => void remove(), { disabled: saving })

  return (
    <ModalShell
      label={job !== undefined ? `Edit job ${draft.name}` : 'New job'}
      className="job-editor"
      showClose
      dirty={dirty}
      onClose={onCancel}
    >
      <form onSubmit={save}>
        <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>
          {job !== undefined ? `Edit “${draft.name || 'job'}”` : 'New job'}
        </h2>

        <div className="form-grid">
          <JobFactsFields
            draft={draft}
            patch={patch}
            errors={errors}
            workspaces={workspaces}
            models={models}
            toolOptions={toolOptions}
            workspaceError={workspaceError}
          />

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
            <>
              <div className="weekday-picker" role="group" aria-label="Days of the week">
                <span className="muted">On days</span>
                {weekdayTokens.map((token, i) => (
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
                    {weekdayShort[i]}
                  </label>
                ))}
              </div>

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
            </>
          )}
        </div>

        {/* the pre-run command is part of the firing decision, so it sits inside
            the trigger block ahead of the preview and idle policy */}
        <TriggerCommandFields
          draft={draft}
          patch={patch}
          errors={errors}
          label="Pre-run command (optional)"
        />
        {draft.triggerCommand.trim() !== '' && (
          <p className="muted small-note">
            The command runs via sh -c before each fire; a non-matching outcome records the fire as
            skipped. When the job runs, its output is placed ahead of the prompt.
          </p>
        )}

        {previewError !== '' ? (
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

        <h3 style={{ display: 'flex', alignItems: 'center', gap: 'calc(var(--unit) * 2)' }}>
          <label htmlFor="job-run-when-idle">Run when idle</label>
          <input
            type="checkbox"
            id="job-run-when-idle"
            checked={draft.runWhenIdle}
            onChange={(ev) => patch({ runWhenIdle: ev.target.checked })}
          />
        </h3>
        <div className="form-grid">
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
            Timeout (minutes, 0 = unlimited)
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
              onClick={confirm.onClick}
              onBlur={confirm.onBlur}
              disabled={saving}
            >
              {confirm.armed ? 'Really delete?' : 'Delete…'}
            </button>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <ModalCancelButton disabled={saving} />
          <button
            className="primary"
            type="submit"
            disabled={saving || Object.keys(errors).length > 0}
          >
            {job !== undefined ? 'Save changes' : 'Create job'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
