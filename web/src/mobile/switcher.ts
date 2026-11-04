// The switcher's pure model: rows for the bottom sheet and the home launcher,
// derived from the fleet listing plus the shared attention digest. Alive
// sessions sort first (dialogs by oldest wait, then busy, then resting), with
// the last four exited swarm children kept beneath them so a fresh exit stays
// one tap from resume.
import type { SessionStatus } from '../api/types'
import type { AttentionItem } from '../workspace/attention'

// maxExitedRows caps the exited tail; older runs stay reachable through saved
// sessions and their transcripts.
const maxExitedRows = 4

type SwitcherStatus = 'running' | 'waiting' | 'idle' | 'ended'

export interface SwitcherRow {
  sessionId: string
  label: string // rendered through the shared display-name helper upstream
  status: SwitcherStatus
  needsInput: boolean // open dialogs; badged, counts toward the attention count
  reason: string // one-line digest reason when attention knows this session
  checkOff: boolean // a row that may be acknowledged; waiting rows refuse
  exitedAt?: number // unix milliseconds, ended swarm children only
}

// buildSwitcherRows folds the listing and attention items into sheet rows.
// Attention is keyed by session id and optional: a missing digest merely drops
// badges and reasons until its next poll.
export function buildSwitcherRows(
  sessions: readonly SessionStatus[],
  labelFor: (s: SessionStatus) => string,
  items?: readonly AttentionItem[],
): SwitcherRow[] {
  const byId = new Map(items?.map((i) => [i.sessionId, i]))

  const alive: Array<{ row: SwitcherRow; rank: number; since: number }> = []
  const exited: SwitcherRow[] = []
  for (const s of sessions) {
    if (isEnded(s)) {
      exited.push({
        sessionId: s.sessionId,
        label: labelFor(s),
        status: 'ended',
        needsInput: false,
        reason: s.detail ?? '',
        checkOff: false,
        exitedAt: s.exitedAt,
      })
      continue
    }
    const item = byId.get(s.sessionId)
    alive.push({
      rank: attentionRank(item),
      since: item?.since ?? 0,
      row: {
        sessionId: s.sessionId,
        label: labelFor(s),
        status: statusOf(s, item),
        needsInput: item?.kind === 'needs-input',
        reason: item?.reason ?? '',
        checkOff:
          item !== undefined && (item.kind === 'needs-input' || item.kind === 'needs-review'),
      },
    })
  }

  // dialogs by oldest wait, then busy before resting; name-stable otherwise
  alive.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.since - b.since ||
      a.row.label.localeCompare(b.row.label) ||
      a.row.sessionId.localeCompare(b.row.sessionId),
  )
  exited.sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0))
  return [...alive.map((a) => a.row), ...exited.slice(0, maxExitedRows)]
}

// isEnded reports a session whose run finished; gone means the service no
// longer sees it at all, which reads as ended for switching purposes.
function isEnded(s: SessionStatus): boolean {
  return s.state === 'exited' || s.state === 'gone'
}

function statusOf(s: SessionStatus, item: AttentionItem | undefined): SwitcherStatus {
  const busy = s.running || (item?.running ?? false)
  if (busy) return 'running'
  if (item?.kind === 'awaiting') return 'waiting'
  return 'idle'
}

// attentionRank orders the alive rows: dialogs first, then unreviewed turns,
// then working and waiting sessions together.
function attentionRank(item: AttentionItem | undefined): number {
  switch (item?.kind) {
    case 'needs-input':
      return 0
    case 'needs-review':
      return 1
    default:
      return 2
  }
}
