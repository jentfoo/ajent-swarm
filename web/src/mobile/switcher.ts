// The switcher's pure model: rows for the bottom sheet and the home launcher,
// derived from the fleet listing plus the shared attention digest. Alive rows
// rank like the desktop rail and carry the queue they render under, with a
// trailing Recent section of ended runs so a fresh exit stays one tap from
// resume: at least minEndedRows always, plus every exit inside the recent
// window however many ran.
import { childEnded, type SessionStatus } from '../api/types'
import {
  attentionQueue,
  attentionSectionTitles,
  compareAttention,
  instanceKey,
  isActionable,
  sessionBadgeOf,
  type AttentionItem,
  type AttentionQueue,
  type AttentionSort,
  type SessionBadge,
} from '../workspace/attention'

// The ended tail keeps at least minEndedRows rows; older runs beyond that
// drop off, staying reachable through saved sessions and their transcripts.
const minEndedRows = 4

// Everything ended within this window stays listed beside the minimum. This
// mirrors pkg/fleet's listing cap, so both surfaces agree by construction.
const endedWindowMs = 2 * 60 * 60 * 1000

type SwitcherStatus = SessionBadge | 'ended'

// SwitcherSection mirrors the desktop rail's three queues: states wanting a
// human answer render under Needs input, idle agents under Waiting, busy and
// digest-less rows under Working, and the exited tail last.
type SwitcherSection = AttentionQueue | 'ended'

export interface SwitcherRow {
  sessionId: string
  pid?: number // instance discriminator: twin rows share a session id
  label: string // rendered through the shared display-name helper upstream
  status: SwitcherStatus
  section: SwitcherSection // rail queue, fixed at build time
  reason: string // one-line digest reason when attention knows this session
  queued: number // prompts waiting in the session's queue; badged on launcher rows
  checkOff: boolean // a row that may be acknowledged; waiting rows refuse
  workspace?: string // carried from the listing, the resume target directory
  exitedAt?: number // unix milliseconds, ended sessions
}

// GroupedSwitcherRows is one rendered queue: its id keys and styles the
// block, the title heads it, and the rows keep their incoming order.
interface GroupedSwitcherRows {
  section: SwitcherSection
  title: string
  rows: SwitcherRow[]
}

const sectionOrder: readonly SwitcherSection[] = ['needs', 'waiting', 'working', 'ended']

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
        reason: s.detail ?? '',
        queued: 0, // waiting work cannot outlive the run
        checkOff: false,
        workspace: s.workspace,
        exitedAt: s.exitedAt,
      })
      continue
    }
    const item = digestFor(s)
    const entry: AttentionSort = {
      sessionId: s.sessionId,
      kind: item?.kind,
      since: item?.since,
      queuedAt: item?.queuedAt,
    }
    alive.push({
      ...entry,
      row: {
        sessionId: s.sessionId,
        pid: s.pid,
        label: labelFor(s),
        status: sessionBadgeOf(s.running, item),
        // the row's rail queue: digest-less rows share Working, exactly as
        // attentionRank places them
        section: attentionQueue(entry),
        reason: item?.reason ?? '',
        queued: s.queued,
        workspace: s.workspace,
        checkOff: item !== undefined && isActionable(item.kind),
      },
    })
  }

  alive.sort(compareAttention)
  exited.sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0))
  return [...alive.map((a) => a.row), ...capEnded(exited)]
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

// switcherRoute picks the mobile route for one switcher row: ended sessions
// read their transcript read-only, alive ones join the live session view.
// Every mobile surface that opens a switcher row navigates through this, so
// the two routes can never drift apart.
export function switcherRoute(row: SwitcherRow): string {
  const base = row.status === 'ended' ? '/m/read/' : '/s/'
  return `${base}${encodeURIComponent(row.sessionId)}`
}

// groupSwitcherRows slices rows into rail-ordered queues for rendering,
// keeping each queue's incoming order rather than re-sorting, so mobile and
// desktop can never disagree. Empty queues drop out and the ended tail
// keeps its window rule even when a producer skips it.
export function groupSwitcherRows(rows: readonly SwitcherRow[]): GroupedSwitcherRows[] {
  return sectionOrder.flatMap((section): GroupedSwitcherRows[] => {
    const matched = rows.filter((r) => r.section === section)
    // the render path enforces the ended window even when a producer skips it
    const sectionRows = section === 'ended' ? capEnded(matched) : matched
    if (sectionRows.length === 0) return []
    // only the ended tail is switcher-specific; alive headings read the
    // shared queue titles so the sheet cannot drift from the desktop rail
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
