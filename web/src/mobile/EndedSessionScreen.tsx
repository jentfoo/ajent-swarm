import { useState } from 'react'
import type { ReactElement } from 'react'
import { Link, useLocation, useNavigate, useNavigationType, useParams } from 'react-router'

import { describeError } from '../api/errors'
import { fleet as fleetAPI } from '../api/endpoints'
import { TranscriptPreview } from '../jobs/TranscriptPreview'
import { useResume } from '../hooks/useResume'

// EndedSessionScreen is an ended session's read-only transcript with a Resume
// button that launches headless `--resume id`. The recording rides the saved-
// entries endpoint, so it works however long ago the run finished.
export default function EndedSessionScreen(): ReactElement {
  const { sessionId = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const navType = useNavigationType()

  // Back pops history only with an in-app entry behind this screen. Cold deep
  // links carry react-router's 'default' key; the login redirect also lands
  // here cold, but replace rewrites location.key, so its navigation type closes
  // that gap.
  const canGoBack = location.key !== 'default' && navType !== 'REPLACE'

  return (
    <div className="ended-screen">
      <header className="pushed-header">
        {canGoBack ? (
          <button type="button" onClick={() => navigate(-1)}>
            ← Back
          </button>
        ) : (
          // launcher link: never pops out of the app on a cold entry
          <Link to="/">← Back</Link>
        )}
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
      setLookupError(describeError(err, 'Resume failed.'))
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
