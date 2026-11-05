// The switcher's pure model: rows for the bottom sheet and the home launcher,
// derived from the fleet listing plus the shared attention digest. Alive rows
// rank like the desktop rail and carry the section they render under, with
// the last four exited swarm children kept in a trailing Recent section so a
// fresh exit stays one tap from resume.
import { childEnded, type SessionStatus } from '../api/types'
import type { AttentionItem } from '../workspace/attention'

// maxExitedRows caps the ended tail; older runs stay reachable through saved
// sessions and their transcripts.
const maxExitedRows = 4

type SwitcherStatus = 'running' | 'waiting' | 'idle' | 'ended'

// SwitcherSection mirrors the desktop rail's grouping: dialogs, unreviewed
// completions and agents waiting for a prompt render under Needs input, busy
// and digest-less rows under Working, and the exited tail last.
export type SwitcherSection = 'needs' | 'working' | 'ended'

export interface SwitcherRow {
  sessionId: string
  label: string // rendered through the shared display-name helper upstream
  status: SwitcherStatus
  section: SwitcherSection // desktop rail grouping, fixed at build time
  needsInput: boolean // open dialogs; badged, counts toward the attention count
  reason: string // one-line digest reason when attention knows this session
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

// sectionTitles matches the desktop rail's labels; the ended tail reads as
// "Recent" on phones.
const sectionTitles: Record<SwitcherSection, string> = {
  needs: 'Needs input',
  working: 'Working',
  ended: 'Recent',
}

// Desktop order: needs first, working below, ended last.
const sectionOrder: readonly SwitcherSection[] = ['needs', 'working', 'ended']

// buildSwitcherRows folds the listing and attention items into sheet rows.
// Attention is keyed by session id and optional: a missing digest merely drops
// badges and reasons until its next poll.
export function buildSwitcherRows(
  sessions: readonly SessionStatus[],
  labelFor: (s: SessionStatus) => string,
  items?: readonly AttentionItem[],
): SwitcherRow[] {
  const byId = new Map(items?.map((i) => [i.sessionId, i]))

  const alive: AliveRow[] = []
  const exited: SwitcherRow[] = []
  for (const s of sessions) {
    if (childEnded(s.state)) {
      exited.push({
        sessionId: s.sessionId,
        label: labelFor(s),
        status: 'ended',
        section: 'ended',
        needsInput: false,
        reason: s.detail ?? '',
        checkOff: false,
        workspace: s.workspace,
        exitedAt: s.exitedAt,
      })
      continue
    }
    const item = byId.get(s.sessionId)
    const cls = attentionClass(item)
    alive.push({
      cls,
      since: item?.since ?? 0,
      row: {
        sessionId: s.sessionId,
        label: labelFor(s),
        status: statusOf(s, item),
        section: cls === workingClass ? 'working' : 'needs',
        needsInput: item?.kind === 'needs-input',
        reason: item?.reason ?? '',
        workspace: s.workspace,
        checkOff:
          item !== undefined && (item.kind === 'needs-input' || item.kind === 'needs-review'),
      },
    })
  }

  alive.sort(compareAlive)
  exited.sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0))
  return [...alive.map((a) => a.row), ...exited.slice(0, maxExitedRows)]
}

// groupSwitcherRows slices rows into desktop-ordered sections for rendering,
// keeping each section's incoming order rather than re-sorting, so mobile and
// desktop can never disagree. Empty sections drop out and the ended tail
// stays capped at maxExitedRows.
export function groupSwitcherRows(rows: readonly SwitcherRow[]): GroupedSwitcherRows[] {
  return sectionOrder.flatMap((section): GroupedSwitcherRows[] => {
    const matched = rows.filter((r) => r.section === section)
    // the render path enforces the exited cap even when a producer skips it
    const sectionRows = section === 'ended' ? matched.slice(0, maxExitedRows) : matched
    if (sectionRows.length === 0) return []
    return [{ section, title: sectionTitles[section], rows: sectionRows }]
  })
}

// AliveRow pairs a row with its sort facts: the attention class and the
// moment the attention state started.
interface AliveRow {
  row: SwitcherRow
  cls: number
  since: number
}

const workingClass = 3 // the one attention class outside Needs input

// attentionClass mirrors rankAttention's rank: dialogs, unreviewed
// completions, then waiting agents; working and digest-less rows share the
// working class.
function attentionClass(item: AttentionItem | undefined): number {
  switch (item?.kind) {
    case 'needs-input':
      return 0
    case 'needs-review':
      return 1
    case 'awaiting':
      return 2
    default:
      return workingClass
  }
}

// compareAlive mirrors rankAttention: dialogs by oldest wait, unreviewed
// completions newest first, the rest stable by session id, so grouping can
// never disagree with the desktop rail.
function compareAlive(a: AliveRow, b: AliveRow): number {
  if (a.cls !== b.cls) return a.cls - b.cls
  if (a.cls === 0) return a.since - b.since // dialogs: oldest wait first
  if (a.cls === 1) return b.since - a.since // completions: newest first
  return a.row.sessionId.localeCompare(b.row.sessionId)
}

function statusOf(s: SessionStatus, item: AttentionItem | undefined): SwitcherStatus {
  const busy = s.running || (item?.running ?? false)
  if (busy) return 'running'
  if (item?.kind === 'awaiting') return 'waiting'
  return 'idle'
}
