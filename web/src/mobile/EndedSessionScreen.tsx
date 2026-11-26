import { useState } from 'react'
import type { ReactElement } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { describeError } from '../api/errors'
import { fleet as fleetAPI } from '../api/endpoints'
import { TranscriptPreview } from '../jobs/TranscriptPreview'
import { useCanGoBack } from '../hooks/useCanGoBack'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useResume } from '../hooks/useResume'
import { shortID } from '../session/names'
import { useSessionLabel } from '../session/useSessionLabel'

// EndedSessionScreen is an ended session's read-only transcript with a Resume
// button that launches headless `--resume target`. The recording rides the
// saved-entries endpoint, so it works however long ago the run finished.
export default function EndedSessionScreen(): ReactElement {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()

  // the roster's label once known, otherwise the screen's own name instead of
  // an opaque short id in the browser chrome
  const label = useSessionLabel(sessionId)
  useDocumentTitle(label === shortID(sessionId) ? 'Ended session' : label)

  const canGoBack = useCanGoBack()

  return (
    <div className="ended-screen">
      <header className="pushed-header">
        {canGoBack ? (
          <button type="button" onClick={() => navigate(-1)}>
            ← Back
          </button>
        ) : (
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
      // resume on the row's listed target, matching MobileHome; a named row
      // carries id != target so this lookup may match by either field
      await resume(row.workspace, row.target)
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
