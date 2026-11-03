import { useState } from 'react'
import { Link } from 'react-router'

import { childEnded, type Run, type SessionStatus } from '../api/types'
import { useSwarm } from '../providers/swarm'
import { runStatusClass, formatDuration, formatTimestamp } from './schedule'
import { TranscriptPreview } from './TranscriptPreview'
import { ModalShell } from '../ui/ModalShell'

// RunDetail explains what one run did: its facts, the prompt and error in
// full, then the session it produced. Live sessions open into a view,
// finished ones render their recorded transcript right here.
export function RunDetail({ run, onClose }: { run: Run; onClose: () => void }) {
  const [showLiveTranscript, setShowLiveTranscript] = useState(false)
  const status = useSwarm().sessions.find((s) => s.sessionId === run.sessionId)

  return (
    <ModalShell label={`Run ${run.id}`} className="run-detail" showClose onClose={onClose}>
      <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>
        Run #{run.id}{' '}
        <span className={runStatusClass(run.status)} data-testid="detail-status">
          {run.status}
        </span>
      </h2>

      <RunFacts run={run} />

      {run.prompt && (
        <>
          <h3>Prompt</h3>
          <pre className="mono run-prompt">{run.prompt}</pre>
        </>
      )}

      {run.error && (
        <>
          <h3>What went wrong</h3>
          <p className="error-text run-error">{run.error}</p>
        </>
      )}

      {run.sessionId && (
        <RunSessionFacts
          run={run}
          status={status}
          showTranscript={showLiveTranscript}
          onShowTranscript={() => setShowLiveTranscript(true)}
        />
      )}
    </ModalShell>
  )
}

function RunFacts({ run }: { run: Run }) {
  return (
    <dl className="run-facts">
      <dt>Started</dt>
      <dd>{formatTimestamp(run.startedAt)}</dd>
      <dt>Finished</dt>
      <dd>{formatTimestamp(run.finishedAt)}</dd>
      <dt>Duration</dt>
      <dd>{formatDuration(run.startedAt, run.finishedAt)}</dd>
      <dt>Trigger</dt>
      <dd>{run.trigger}</dd>
    </dl>
  )
}

// RunSessionFacts routes to what the run created: a live session opens in the
// session view; anything else renders its recorded transcript inline.
function RunSessionFacts({
  run,
  status,
  showTranscript,
  onShowTranscript,
}: {
  run: Run
  status?: SessionStatus
  showTranscript: boolean
  onShowTranscript: () => void
}) {
  const live = status !== undefined && !childEnded(status.state)
  return (
    <>
      <h3>Session</h3>
      <p className="mono muted">
        {run.sessionId}
        {status?.state ? ` · ${status.state}` : ''}
      </p>
      {live && !showTranscript && (
        <p>
          <Link to={`/s/${encodeURIComponent(run.sessionId!)}`}>
            <button type="button" className="primary">
              Open session view
            </button>
          </Link>{' '}
          <button type="button" onClick={onShowTranscript}>
            View transcript here
          </button>
        </p>
      )}
      {(!live || showTranscript) && <TranscriptPreview sessionId={run.sessionId!} />}
    </>
  )
}
