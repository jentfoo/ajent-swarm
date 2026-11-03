import type { CtlState, Segment } from '../api/types'

// StatusStrip is the slim strip above the composer: one data source with the
// desktop status bar. It renders the streamed status segments plus queue count,
// activity dots and usage totals — everything side rails used to show. Token
// totals count request-and-response terms only; cache reads never cost.
export function StatusStrip({ snap }: { snap: CtlState }) {
  const segments = snap.status?.segments ?? []
  const activities = snap.activity ?? []
  if (segments.length === 0 && activities.length === 0 && snap.queued === 0) return null

  return (
    <div className="status-strip" role="status" aria-label="Session status">
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
