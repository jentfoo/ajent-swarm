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

// Sub-agent activity rows (sub-N keys upstream), surfaced as chips instead
// of vanishing into the generic activity mix.
export function subAgentRows(activity: ActivityRow[] | undefined): ActivityRow[] {
  return (activity ?? []).filter((row) => row.key.startsWith('sub-'))
}

// subAgentCounts parses the running/queued/done tally out of the upstream
// subagents segment's published wording. Missing parts degrade to zero, so a
// wording drift loses precision without hiding jobs activity rows still know.
export function subAgentCounts(seg?: Segment): { running: number; queued: number; done: number } {
  const count = (re: RegExp) => Number(re.exec(seg?.text ?? '')?.[1] ?? 0)
  return {
    running: count(/(\d+) running/),
    queued: count(/(\d+) queued/),
    done: count(/(\d+) done/),
  }
}

// subAgentLabel reads "2 active · 9 total · 6 done": live jobs, the batch and
// completions. Zero facts drop, so a fresh batch never opens with a zero.
export function subAgentLabel(active: number, total: number, done: number): string {
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
// context meter, queue depth and the current activity line. Model and
// permission mode live in the header; the upstream permissions segment never
// renders here.
export function StatusBar({ snap, live }: { snap: CtlState; live?: LiveTurn | null }) {
  const segments = visibleSegments(snap.status?.segments)
  const subs = subAgentRows(snap.activity)
  const activity =
    (snap.activity ?? []).find((row) => !subs.some((s) => s.key === row.key))?.text ?? ''
  const { used, window: win, compact } = snap.context

  return (
    <div className="status-bar" role="status" aria-label="Session status">
      <Spinner state={spinnerState(snap, live)} />
      {activity && <span className="bar-activity">{activity}</span>}
      {segments.map((seg) => (
        <SegmentChip key={seg.key} seg={seg} />
      ))}
      <SubAgentBadge subs={subs} segments={snap.status?.segments} />
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
// segment chip and a bare live count: active jobs come from activity rows,
// total and done parse out of upstream's segment. Detail rides the tooltip.
function SubAgentBadge({ subs, segments }: { subs: ActivityRow[]; segments?: Segment[] }) {
  const seg = (segments ?? []).find((s) => s.key === 'subagents' && s.text !== '')
  const counts = subAgentCounts(seg)
  const active = subs.length > 0 ? subs.length : counts.running + counts.queued
  if (active === 0 && counts.done === 0) {
    // No parseable tally and nothing live: keep upstream's own wording rather
    // than hiding a segment it is still publishing.
    return seg ? (
      <span className="badge" title={seg.text}>
        {seg.text}
      </span>
    ) : null
  }
  const detail = [seg?.text, ...subs.map((s) => s.text)].filter(Boolean).join('\n')
  return (
    <span
      className={`badge ${active > 0 ? 'accent' : ''}`}
      title={detail === '' ? undefined : detail}
    >
      {subAgentLabel(active, active + counts.done, counts.done)}
    </span>
  )
}
