// The switcher's pure model: rows for the bottom sheet and the home launcher,
// derived from the fleet listing plus the shared attention digest. Alive rows
// rank like the desktop rail and carry the section they render under, with a
// trailing Recent section of ended runs so a fresh exit stays one tap from
// resume: at least minEndedRows always, plus every exit inside the recent
// window however many ran.
import { childEnded, type SessionStatus } from '../api/types'
import {
  attentionSectionTitles,
  compareAttention,
  type AttentionItem,
  type AttentionKind,
  type AttentionSort,
} from '../workspace/attention'

// The ended tail keeps at least minEndedRows rows; older runs beyond that
// drop off, staying reachable through saved sessions and their transcripts.
const minEndedRows = 4

// Everything ended within this window stays listed beside the minimum. This
// mirrors pkg/fleet's listing cap, so both surfaces agree by construction.
const endedWindowMs = 2 * 60 * 60 * 1000

type SwitcherStatus = 'running' | 'waiting' | 'idle' | 'ended'

// SwitcherSection mirrors the desktop rail's grouping: each attention kind
// renders under its own shared heading, digest-less rows beside working, and
// the exited tail last.
export type SwitcherSection = AttentionKind | 'ended'

export interface SwitcherRow {
  sessionId: string
  pid?: number // instance discriminator: twin rows share a session id
  label: string // rendered through the shared display-name helper upstream
  status: SwitcherStatus
  section: SwitcherSection // desktop rail grouping, fixed at build time
  needsInput: boolean // open dialogs; badged, counts toward the attention count
  reason: string // one-line digest reason when attention knows this session
  queued: number // prompts waiting in the session's queue; badged on launcher rows
  checkOff: boolean // a row that may be acknowledged; waiting rows refuse
  workspace?: string // carried from the listing, the resume target directory
  exitedAt?: number // unix milliseconds, ended sessions
}

// GroupedSwitcherRows is one rendered section: its id keys and styles the
// block, the title heads it, and the rows keep their incoming order.
export interface GroupedSwitcherRows {
  section: SwitcherSection
  title: string
  rows: SwitcherRow[]
}

// Desktop order: dialogs, completions, waiting agents, working, ended last.
const sectionOrder: readonly SwitcherSection[] = [
  'needs-input',
  'needs-review',
  'awaiting',
  'working',
  'ended',
]

// buildSwitcherRows folds the listing and attention items into sheet rows.
// Attention is optional: a missing digest merely drops badges and reasons
// until its next poll. Digests pair with their own instance when both sides
// know the pid; otherwise any digest for the session stands in.
export function buildSwitcherRows(
  sessions: readonly SessionStatus[],
  labelFor: (s: SessionStatus) => string,
  items?: readonly AttentionItem[],
): SwitcherRow[] {
  const byInstance = new Map(items?.map((i) => [instanceKey(i.sessionId, i.pid), i]))
  const bySession = new Map(items?.map((i) => [i.sessionId, i]))
  const digestFor = (s: SessionStatus): AttentionItem | undefined =>
    (s.pid !== undefined ? byInstance.get(instanceKey(s.sessionId, s.pid)) : undefined) ??
    bySession.get(s.sessionId)

  const alive: AliveRow[] = []
  const exited: SwitcherRow[] = []
  for (const s of sessions) {
    if (childEnded(s.state)) {
      exited.push({
        sessionId: s.sessionId,
        pid: s.pid,
        label: labelFor(s),
        status: 'ended',
        section: 'ended',
        needsInput: false,
        reason: s.detail ?? '',
        queued: 0, // waiting work cannot outlive the run
        checkOff: false,
        workspace: s.workspace,
        exitedAt: s.exitedAt,
      })
      continue
    }
    const item = digestFor(s)
    const entry = { sessionId: s.sessionId, kind: item?.kind, since: item?.since }
    alive.push({
      ...entry,
      row: {
        sessionId: s.sessionId,
        pid: s.pid,
        label: labelFor(s),
        status: statusOf(s, item),
        // the row's rail heading: digest-less rows share Working, exactly as
        // attentionRank places them
        section: item?.kind ?? 'working',
        needsInput: item?.kind === 'needs-input',
        reason: item?.reason ?? '',
        queued: s.queued,
        workspace: s.workspace,
        checkOff:
          item !== undefined && (item.kind === 'needs-input' || item.kind === 'needs-review'),
      },
    })
  }

  alive.sort(compareAttention)
  exited.sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0))
  return [...alive.map((a) => a.row), ...capEnded(exited)]
}

// instanceKey names one listing row: twin instances share a session id and
// are told apart by pid, with 0 standing in for an unknown one.
function instanceKey(sessionId: string, pid?: number): string {
  return `${sessionId}:${pid ?? 0}`
}

// capEnded keeps the pinned minimum plus every exit inside the recent window;
// rows arrive most-recent-first, so everything past the window drops as one
// tail. Rows without a timestamp rank oldest and only fill the minimum.
function capEnded(rows: readonly SwitcherRow[]): SwitcherRow[] {
  if (rows.length <= minEndedRows) return [...rows]
  const now = Date.now()
  let kept = minEndedRows
  while (
    kept < rows.length &&
    rows[kept].exitedAt !== undefined &&
    now - rows[kept].exitedAt! <= endedWindowMs
  ) {
    kept++
  }
  return rows.slice(0, kept)
}

// groupSwitcherRows slices rows into desktop-ordered sections for rendering,
// keeping each section's incoming order rather than re-sorting, so mobile and
// desktop can never disagree. Empty sections drop out and the ended tail
// keeps its window rule even when a producer skips it.
export function groupSwitcherRows(rows: readonly SwitcherRow[]): GroupedSwitcherRows[] {
  return sectionOrder.flatMap((section): GroupedSwitcherRows[] => {
    const matched = rows.filter((r) => r.section === section)
    // the render path enforces the ended window even when a producer skips it
    const sectionRows = section === 'ended' ? capEnded(matched) : matched
    if (sectionRows.length === 0) return []
    // only the ended tail is switcher-specific; alive headings read the
    // shared rail titles so the sheet cannot drift from the desktop sections
    const title = section === 'ended' ? 'Recent' : attentionSectionTitles[section]
    return [{ section, title, rows: sectionRows }]
  })
}

// AliveRow pairs a row with the sort facts the shared attention order reads:
// rows without a digest carry only their session id, so they rank with
// working yet stay name-stable.
interface AliveRow extends AttentionSort {
  row: SwitcherRow
}

function statusOf(s: SessionStatus, item: AttentionItem | undefined): SwitcherStatus {
  const busy = s.running || (item?.running ?? false)
  if (busy) return 'running'
  if (item?.kind === 'awaiting') return 'waiting'
  return 'idle'
}
