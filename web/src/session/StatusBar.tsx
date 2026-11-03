import type { ActivityRow, CtlState, Segment } from '../api/types'
import { Spinner, spinnerState } from './Spinner'
import { barActivity, subAgentTally } from './subAgents'
import { contextCount, contextLevel, contextPct, contextTitle, usageTitle } from './statusMeter'
import type { LiveTurn } from '../state/eventApplier'

// subAgentLabel reads "2 active · 9 total · 6 done": live jobs, the batch and
// completions. Zero facts drop, so a fresh batch never opens with a zero.
function subAgentLabel(active: number, total: number, done: number): string {
  const parts: string[] = []
  if (active > 0) parts.push(`${active} active`)
  if (done > 0) parts.push(`${total} total`, `${done} done`)
  return `agents ${parts.join(' · ')}`
}

// specialSegments are keys that never render as a plain chip: permissions is
// header chrome and sub-agents get their own tally badge below.
const specialSegments = new Set(['permissions', 'subagents'])

// visibleSegments drops empty text and chrome-owned keys: what the slim
// status line renders from a snapshot's segments.
function visibleSegments(segments: Segment[] | undefined): Segment[] {
  return (segments ?? []).filter((seg) => seg.text !== '' && !specialSegments.has(seg.key))
}

// StatusBar is the slim line under the transcript answering "what is the
// agent doing" at a glance: the working glyph, streamed status segments,
// context meter with its token count, queue depth and the current activity
// rows. Model and permission mode live in the header; the upstream
// permissions segment never renders here.
export function StatusBar({ snap, live }: { snap: CtlState; live?: LiveTurn | null }) {
  const segments = visibleSegments(snap.status?.segments)
  const activity = barActivity(snap.activity)
  const pct = contextPct(snap.context)

  return (
    <div className="status-bar" role="status" aria-label="Session status">
      <Spinner state={spinnerState(snap, live)} />
      {activity.rows.length > 0 && (
        <>
          <span className="bar-activity">{activity.rows.map((row) => row.text).join(' · ')}</span>
          {activity.overflow > 0 && <span className="muted">+{activity.overflow} more</span>}
        </>
      )}
      {segments.map((seg) => (
        <SegmentChip key={seg.key} seg={seg} />
      ))}
      <SubAgentBadge activity={snap.activity} segments={snap.status?.segments} />
      {snap.context.window > 0 && (
        <span
          className={`meter ${contextLevel(snap.context)}`}
          role="img"
          aria-label={`Context ${Math.round(pct)}% full`}
          title={contextTitle(snap.context)}
        >
          <span className="meter-track">
            <span className="meter-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="meter-count">{contextCount(snap.context)}</span>
        </span>
      )}
      {snap.queued > 0 && <span className="badge">{snap.queued} queued</span>}
      {snap.usage.turns > 0 && (
        <span className="strip-segment muted" title={usageTitle(snap.usage)}>
          {snap.usage.turns} turns
        </span>
      )}
    </div>
  )
}

// SegmentChip paints one segment: the full label while the bar has room,
// upstream's short form under width pressure. Both render and CSS picks, so
// screen readers hear only the long one.
function SegmentChip({ seg }: { seg: Segment }) {
  const dual = !!seg.short && seg.text !== '' && seg.text !== seg.short
  return (
    <span className={`strip-segment ${seg.order < 0 ? 'muted' : ''}`} data-segment-key={seg.key}>
      {dual ? (
        <>
          <span className="seg-text">{seg.text}</span>
          <span className="seg-short" aria-hidden>
            {seg.short}
          </span>
        </>
      ) : (
        seg.text || seg.short
      )}
    </span>
  )
}

// SubAgentBadge is the one sub-agent tally, replacing both the short-form
// segment chip and a bare live count: live jobs come from activity rows,
// completions from the segment's structured counts with the prose parse as
// the pre-12a fallback. Detail rides the tooltip.
function SubAgentBadge({ activity, segments }: { activity?: ActivityRow[]; segments?: Segment[] }) {
  const { active, done, rows, segment } = subAgentTally(activity, segments)
  if (active === 0 && done === 0) {
    // No parseable tally and nothing live: keep upstream's own wording rather
    // than hiding a segment it is still publishing.
    return segment ? (
      <span className="badge" title={segment.text}>
        {segment.text}
      </span>
    ) : null
  }
  const detail = [segment?.text, ...rows.map((s) => s.text)].filter(Boolean).join('\n')
  return (
    <span
      className={`badge ${active > 0 ? 'accent' : ''}`}
      title={detail === '' ? undefined : detail}
    >
      {subAgentLabel(active, active + done, done)}
    </span>
  )
}
