import type { ActivityRow, CtlState, Segment } from '../api/types'
import { Spinner, spinnerState } from './Spinner'
import type { LiveTurn } from '../state/eventApplier'

// contextLevel colors the context meter: normal below it, warn as the window
// closes in on compaction and danger once the run crosses the line.
export function contextLevel(used: number, windowSize: number, compact: number): string {
  if (windowSize <= 0 || used <= 0) return ''
  if (compact > 0 && used >= compact * 0.9) return 'danger'
  if (compact > 0 && used >= compact * 0.7) return 'warn'
  const pct = (used / windowSize) * 100
  if (pct >= 90) return 'warn'
  return ''
}

// SubAgentChip rows are the sub-agent activity rows (sub-N keys upstream),
// surfaced as chips instead of vanishing into the generic activity mix.
export function subAgentRows(activity: ActivityRow[] | undefined): ActivityRow[] {
  return (activity ?? []).filter((row) => row.key.startsWith('sub-'))
}

// chromeSegments are the keys the header owns; their segments never render in
// a status line, so "auto+w" never sits beside the mode chip saying auto+write.
const chromeSegments = new Set(['permissions'])

// visibleSegments drops empty text and chrome-owned keys: what the slim
// status line renders from a snapshot's segments.
function visibleSegments(segments: Segment[] | undefined): Segment[] {
  return (segments ?? []).filter((seg) => seg.text !== '' && !chromeSegments.has(seg.key))
}

// StatusBar is the slim line under the transcript answering "what is the
// agent doing" at a glance: the working glyph, streamed status segments,
// context meter, queue depth and the current activity line. Model and
// permission mode live in the header; the upstream permissions segment never
// renders here.
export function StatusBar({ snap, live }: { snap: CtlState; live?: LiveTurn | null }) {
  const segments = visibleSegments(snap.status?.segments)
  const subs = subAgentRows(snap.activity)
  const activity = topActivity(snap.activity, subs)
  const { used, window: win, compact } = snap.context

  return (
    <div className="status-bar" role="status" aria-label="Session status">
      <Spinner state={spinnerState(snap, live)} />
      {activity && <span className="bar-activity">{activity}</span>}
      {segments.map((seg) => (
        <SegmentChip key={seg.key} seg={seg} />
      ))}
      {subs.length > 0 && (
        <span className="badge accent" title={subs.map((s) => s.text).join('\n')}>
          {subs.length} agent{subs.length === 1 ? '' : 's'}
        </span>
      )}
      {win > 0 && (
        <span
          className={`meter ${contextLevel(used, win, compact)}`}
          role="img"
          aria-label={`Context ${Math.round((used / win) * 100)}% full`}
          title={`context ${used}/${win} tokens${compact > 0 ? `, compacts at ${compact}` : ''}`}
        >
          <div style={{ width: `${Math.min(100, (used / win) * 100)}%` }} />
        </span>
      )}
      {snap.queued > 0 && <span className="badge">{snap.queued} queued</span>}
      {snap.usage.turns > 0 && (
        <span
          className="strip-segment muted"
          title={`${snap.usage.total.input.toLocaleString()} in / ${snap.usage.total.output.toLocaleString()} out`}
        >
          {snap.usage.turns} turns
        </span>
      )}
    </div>
  )
}

// topActivity picks the highest-ranked non-sub activity row's text: the
// current step of the turn, one line.
function topActivity(activity: ActivityRow[] | undefined, subs: ActivityRow[]): string {
  const rows = (activity ?? []).filter((row) => !subs.some((s) => s.key === row.key))
  return rows[0]?.text ?? ''
}

// SegmentChip paints one segment; short text wins when set.
function SegmentChip({ seg }: { seg: Segment }) {
  return (
    <span className={`strip-segment ${seg.order < 0 ? 'muted' : ''}`} data-segment-key={seg.key}>
      {seg.short || seg.text}
    </span>
  )
}
