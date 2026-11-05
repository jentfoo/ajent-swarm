import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { ModelState, SettingRow } from '../api/types'
import { ModelSelectOptions } from '../ui/ModelSelectOptions'

// hiddenSettingKeys are rows other chat chrome owns: tools live behind the
// /tools buttons and mode lives in the header dropdown, so neither repeats as
// a settings row on desktop or mobile.
const hiddenSettingKeys = new Set(['tools.enabled', 'permissions.mode'])

function visibleSettingRows(rows: SettingRow[]): SettingRow[] {
  return rows.filter((row) => !hiddenSettingKeys.has(row.key ?? ''))
}

// SettingsMenu is the shared settings.get/settings.set menu: rows grouped in
// ajent's /settings order, one call per change with persist left off so edits
// stay session-only by default. Both the mobile full-screen route and phase
// 14's desktop hamburger render this component.
export function SettingsMenu({ sessionId }: { sessionId: string }): ReactElement {
  const [rows, setRows] = useState<SettingRow[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    sessionAPI
      .settings(sessionId)
      .then((res) => {
        if (!alive) return
        setRows(res.rows ?? [])
        setError('')
      })
      .catch(
        (err: unknown) =>
          alive && setError(err instanceof ApiError ? err.message : 'Reading settings failed.'),
      )
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sessionId])

  const apply = useCallback(
    async (row: SettingRow, value: unknown) => {
      try {
        const res = await sessionAPI.setSetting(sessionId, row.key ?? '', value)
        setRows((prev) => prev.map((r) => (r.key === row.key ? res.row : r)))
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Change refused.')
      }
    },
    [sessionId],
  )

  return (
    <div className="settings-menu" aria-label="Agent settings">
      {loading && <p className="muted">Reading settings…</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading &&
        visibleSettingRows(rows).map((row) => (
          <SettingEditor
            // the value rides the key so an applied change remounts the editor
            // with a fresh draft instead of syncing state in an effect
            key={`${row.key ?? row.label}:${stringify(row.value)}`}
            row={row}
            sessionId={sessionId}
            onApply={apply}
          />
        ))}
    </div>
  )
}

// SettingEditor renders one row by its value's shape: booleans toggle in
// place, the model picks from the session's own registry, everything else
// edits as text with an Apply button. Uneditable rows render their reason
// instead of a control.
function SettingEditor({
  row,
  sessionId,
  onApply,
}: {
  row: SettingRow
  sessionId: string
  onApply: (row: SettingRow, value: unknown) => Promise<void>
}): ReactElement {
  const [draft, setDraft] = useState(() => stringify(row.value))

  if (!row.editable) {
    return (
      <div className="setting-row disabled" data-setting-key={row.key}>
        <span className="setting-label">{row.label}</span>
        <span className="muted setting-value">
          {stringify(row.value)}
          {row.reason ? ` · ${row.reason}` : ''}
        </span>
      </div>
    )
  }

  if (typeof row.value === 'boolean') {
    return (
      <div className="setting-row" data-setting-key={row.key}>
        <span className="setting-label">{row.label}</span>
        <button
          type="button"
          onClick={() => void onApply(row, !row.value)}
          aria-pressed={row.value}
        >
          {row.value ? 'on' : 'off'}
        </button>
      </div>
    )
  }

  if (row.key === modelSettingKey) {
    return <ModelSettingRow row={row} sessionId={sessionId} draft={draft} onApply={onApply} />
  }

  return (
    <form
      className="setting-row text"
      data-setting-key={row.key}
      onSubmit={(ev) => {
        ev.preventDefault()
        void onApply(row, parseValue(draft))
      }}
    >
      <span className="setting-label">{row.label}</span>
      <input value={draft} onChange={(ev) => setDraft(ev.target.value)} />
      {draft !== stringify(row.value) && <button type="submit">Apply</button>}
    </form>
  )
}

// modelSettingKey is upstream's model row; its value must name a registry
// entry, so it edits as a selection instead of free text.
const modelSettingKey = 'model'

// ModelSettingRow lists models.get's registry for this session and applies
// the chosen key through the same settings.set path as every other row.
// Options render through the shared ModelSelectOptions, the same tiered
// layout every model select and the chat model button use.
function ModelSettingRow({
  row,
  sessionId,
  draft,
  onApply,
}: {
  row: SettingRow
  sessionId: string
  draft: string
  onApply: (row: SettingRow, value: unknown) => Promise<void>
}): ReactElement {
  const [registry, setRegistry] = useState<ModelState[]>([])

  useEffect(() => {
    let alive = true
    sessionAPI
      .models(sessionId)
      .then((res) => alive && setRegistry(res.models ?? []))
      .catch(() => {}) // a failed listing leaves the current value selected
    return () => {
      alive = false
    }
  }, [sessionId])

  return (
    <div className="setting-row text" data-setting-key={row.key}>
      <span className="setting-label">{row.label}</span>
      <select
        value={draft}
        aria-label={row.label}
        onChange={(ev) => void onApply(row, ev.target.value)}
      >
        {!registry.some((m) => m.key === draft) && draft !== '' && (
          <option value={draft}>{draft}</option>
        )}
        <ModelSelectOptions models={registry} />
      </select>
    </div>
  )
}

// stringify renders one wire JSON value for editing; parseValue reads the
// editor's text back in the row's own shape.
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function parseValue(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return text // a plain string the row's own validation will judge
  }
}
