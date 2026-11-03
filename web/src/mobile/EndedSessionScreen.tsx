import { useState } from 'react'
import type { ReactElement } from 'react'
import { useNavigate, useParams } from 'react-router'

import { ApiError } from '../api/client'
import { fleet as fleetAPI } from '../api/endpoints'
import { TranscriptPreview } from '../jobs/TranscriptPreview'

// EndedSessionScreen is an ended session's read-only transcript with a Resume
// button that launches headless `--resume id`. The recording rides the saved-
// entries endpoint, so it works however long ago the run finished.
export default function EndedSessionScreen(): ReactElement {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()

  return (
    <div className="ended-screen">
      <header className="pushed-header">
        <button type="button" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h2>Ended session</h2>
        <ResumeButton sessionId={sessionId} />
      </header>
      <TranscriptPreview sessionId={sessionId} />
    </div>
  )
}

function ResumeButton({ sessionId }: { sessionId: string }): ReactElement {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The workspace must come from somewhere: the saved listing carries it.
  const resume = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const rows = await fleetAPI.saved()
      const row = rows.find((r) => r.id === sessionId || r.target === sessionId)
      if (!row?.workspace) {
        setError('No recorded workspace; launch manually from the home screen.')
        setBusy(false)
        return
      }
      const res = await fleetAPI.launch({
        workspace: row.workspace,
        mode: 'resume',
        target: sessionId, // the listing matched this id directly
      })
      navigate(`/s/${encodeURIComponent(res.sessionId)}`)
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? err.message : 'Resume failed.')
    }
  }

  return (
    <span className="resume-wrap">
      {error && <span className="error-text">{error}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void resume()}
        data-testid="resume-ended"
      >
        {busy ? 'Resuming…' : 'Resume'}
      </button>
    </span>
  )
}
