import { useState } from 'react'
import type { ReactElement } from 'react'
import { useNavigate, useParams } from 'react-router'

import { ApiError } from '../api/client'
import { fleet as fleetAPI } from '../api/endpoints'
import { TranscriptPreview } from '../jobs/TranscriptPreview'
import { useResume } from '../hooks/useResume'

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
  const [busy, setBusy] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const { resume, resumingId, error } = useResume()

  // The workspace must come from somewhere: the saved listing carries it.
  const start = async () => {
    if (busy) return
    setBusy(true)
    setLookupError('')
    try {
      const rows = await fleetAPI.saved()
      const row = rows.find((r) => r.id === sessionId || r.target === sessionId)
      if (!row?.workspace) {
        setLookupError('No recorded workspace; launch manually from the home screen.')
        return
      }
      // the listing matched this id directly, so it rides as the target
      await resume(row.workspace, sessionId)
    } catch (err) {
      setLookupError(err instanceof ApiError ? err.message : 'Resume failed.')
    } finally {
      setBusy(false)
    }
  }

  const starting = busy || resumingId !== null

  return (
    <span className="resume-wrap">
      {(lookupError || error) && <span className="error-text">{lookupError || error}</span>}
      <button
        type="button"
        disabled={starting}
        onClick={() => void start()}
        data-testid="resume-ended"
      >
        {starting ? 'Resuming…' : 'Resume'}
      </button>
    </span>
  )
}
