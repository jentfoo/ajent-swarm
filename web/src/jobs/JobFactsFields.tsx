import { useMemo } from 'react'

import type { ToolState } from '../api/types'
import type { DraftErrors, JobDraft } from './jobDraft'

// Startup permission flags for the launched session.
const permissionOptions = [
  { value: '', label: 'ajent default (asks)' },
  { value: 'read-only', label: 'read-only' },
  { value: 'allow-auto', label: 'allow-auto' },
  { value: 'allow-autowrite', label: 'allow-autowrite' },
  { value: 'allow-all', label: 'allow-all' },
]

// FieldError renders one field-level validation message.
export function FieldError({ text }: { text: string }) {
  return (
    <span className="error-text field-error" role="alert">
      {text}
    </span>
  )
}

// JobFactsFields renders the launch facts both job forms share: name,
// workspace, model, permission and the custom tool set. patch applies partial
// draft edits; workspaces and models feed the picker suggestions, toolOptions
// the tool rows (may be empty when nothing serves). workspaceError surfaces a
// server-side path check beside the field.
export function JobFactsFields({
  draft,
  patch,
  errors,
  workspaces,
  models,
  toolOptions,
  workspaceError = '',
}: {
  draft: JobDraft
  patch: (fields: Partial<JobDraft>) => void
  errors: DraftErrors
  workspaces: string[]
  models: string[]
  toolOptions: ToolState[]
  workspaceError?: string
}) {
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

  return (
    <>
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
        {(errors.workspace ?? workspaceError) !== '' && (
          <FieldError text={errors.workspace ?? workspaceError} />
        )}
      </label>

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
        <select value={draft.permission} onChange={(ev) => patch({ permission: ev.target.value })}>
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
              The chosen set replaces the session's defaults at launch; names this workspace does
              not have are ignored. An empty set runs with no tools at all.
            </p>
          </>
        )}
      </div>
    </>
  )
}
