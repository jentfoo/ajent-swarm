import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { models as modelsAPI, settings as settingsAPI } from '../api/endpoints'
import type { ModelState } from '../api/types'

// TitleModelSelect is the swarm-level session titling model picker. The
// options are the union of live sessions' model registries, grouped per
// provider so same-named models stay distinguishable; an empty value means
// each session names itself with its own model. A stored model that has gone
// missing stays visible flagged as missing, and the titler itself falls back
// to the default when a run with it fails, so a stale value can never break
// titling.
export function TitleModelSelect(): ReactElement {
  const [stored, setStored] = useState('')
  const [options, setOptions] = useState<ModelState[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    settingsAPI
      .get()
      .then((res) => alive && setStored(res.titleModel))
      .catch(() => alive && setError('Reading the titling model failed.'))
    modelsAPI
      .options()
      // an older server may still answer null for an empty fleet
      .then((rows) => alive && setOptions(rows ?? []))
      .catch(() => {}) // no live sessions: only the default is offered
    return () => {
      alive = false
    }
  }, [])

  const available = options.some((m) => m.key === stored)
  const { groups, loose } = providerGroups(options)

  const pick = async (model: string) => {
    setBusy(true)
    setError('')
    try {
      const res = await settingsAPI.set({ titleModel: model })
      setStored(res.titleModel)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Saving the titling model failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setting-row text" data-testid="title-model-setting">
      <span className="setting-label">Session titling model</span>
      <select
        value={stored}
        disabled={busy}
        aria-label="Session titling model"
        onChange={(ev) => void pick(ev.target.value)}
      >
        <option value="">Session model (default)</option>
        {groups.map((g) => (
          <optgroup key={g.provider} label={g.provider}>
            {g.models.map((m) => (
              <option key={m.key} value={m.key}>
                {m.short || m.key}
              </option>
            ))}
          </optgroup>
        ))}
        {/* no provider prefix: render the full key ungrouped */}
        {loose.map((m) => (
          <option key={m.key} value={m.key}>
            {m.key}
          </option>
        ))}
        {/* a stored-but-missing model stays visible until retitled or dropped */}
        {stored !== '' && !available && <option value={stored}>{stored} (missing)</option>}
      </select>
      {error && <span className="error-text">{error}</span>}
    </div>
  )
}

// providerGroups buckets the registry under each key's prefix before its
// first slash, in first-appearance order; keys with no usable prefix come
// back loose.
function providerGroups(models: ModelState[]): {
  groups: { provider: string; models: ModelState[] }[]
  loose: ModelState[]
} {
  const grouped = new Map<string, ModelState[]>()
  const loose: ModelState[] = []
  for (const m of models) {
    const slash = m.key.indexOf('/')
    if (slash < 1) {
      // a bare or leading-slash key has no provider label to show
      loose.push(m)
      continue
    }
    const provider = m.key.slice(0, slash)
    const rows = grouped.get(provider)
    if (rows === undefined) grouped.set(provider, [m])
    else rows.push(m)
  }
  return { groups: [...grouped].map(([provider, ms]) => ({ provider, models: ms })), loose }
}
