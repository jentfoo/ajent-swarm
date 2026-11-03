import type { CtlState, Segment } from '../api/types'
import { Spinner, spinnerState } from '../session/Spinner'
import { visibleSegments } from '../session/StatusBar'
import type { LiveTurn } from '../state/eventApplier'

// StatusStrip is the slim strip above the composer: one data source with the
// desktop status bar. It renders the working glyph, streamed status segments
// plus queue count, activity dots and usage totals — everything side rails
// used to show. Model and permission mode live in the header; the permissions
// segment never renders here, so no "auto+w" shadows the mode dropdown.
export function StatusStrip({ snap, live }: { snap: CtlState; live?: LiveTurn | null }) {
  const segments = visibleSegments(snap.status?.segments)
  const activities = snap.activity ?? []
  if (segments.length === 0 && activities.length === 0 && snap.queued === 0 && !snap.running)
    return null

  return (
    <div className="status-strip" role="status" aria-label="Session status">
      <Spinner state={spinnerState(snap, live)} />
      {snap.queued > 0 && <span className="badge">{snap.queued} queued</span>}
      {segments.map((seg) => (
        <SegmentChip key={seg.key} seg={seg} />
      ))}
      {activities.length > 0 && (
        <span className="activity-dots" aria-label={`${activities.length} active`}>
          {activities.slice(0, 5).map((a) => (
            <span key={a.key} className="dot" title={a.text} />
          ))}
        </span>
      )}
      {snap.usage.turns > 0 && (
        <span
          className="strip-segment muted"
          title={`${snap.usage.total.input.toLocaleString()} in / ${snap.usage.total.output.toLocaleString()} out`}
        >
          {snap.usage.turns} turns ·{' '}
          {(snap.usage.total.input + snap.usage.total.output).toLocaleString()} tokens
        </span>
      )}
    </div>
  )
}

function SegmentChip({ seg }: { seg: Segment }) {
  return (
    <span className={`strip-segment ${seg.order < 0 ? 'muted' : ''}`} data-segment-key={seg.key}>
      {seg.short || seg.text}
    </span>
  )
}
