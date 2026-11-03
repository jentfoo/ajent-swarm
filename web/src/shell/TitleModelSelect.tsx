import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { models as modelsAPI, settings as settingsAPI } from '../api/endpoints'
import type { ModelState } from '../api/types'

// TitleModelSelect is the swarm-level session titling model picker. The
// options are the union of live sessions' model registries; an empty value
// means each session names itself with its own model. A stored model that has
// gone missing stays visible flagged as missing, and the titler itself falls
// back to the default when a run with it fails, so a stale value can never
// break titling.
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
      .then((rows) => alive && setOptions(rows))
      .catch(() => {}) // no live sessions: only the default is offered
    return () => {
      alive = false
    }
  }, [])

  const available = options.some((m) => m.key === stored)

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
        {options.map((m) => (
          <option key={m.key} value={m.key}>
            {m.short || m.key}
          </option>
        ))}
        {/* a stored-but-missing model stays visible until retitled or dropped */}
        {stored !== '' && !available && <option value={stored}>{stored} (missing)</option>}
      </select>
      {error && <span className="error-text">{error}</span>}
    </div>
  )
}
