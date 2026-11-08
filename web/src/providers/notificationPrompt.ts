// Anti-nag state for mobile's contextual notification opt-in. Dismissals
// persist under one versioned localStorage key:
//
//   - a refusal mutes the offer until this page load ends
//   - across page loads it re-offers only once, after a generous interval
//   - the retry's own dismissal ends the prompting for good
//
// Corrupt or unreadable storage degrades to showing the prompt again, which is
// acceptable for an opt-in (see swarm.notifyPrompt.v1 handling).
import type { NotificationPermission } from './notifications'

const storageKey = 'swarm.notifyPrompt.v1'

// One retry, then never again: two recorded refusals spend the offer.
const retryAfterMs = 7 * 24 * 60 * 60 * 1000

interface PromptRecord {
  dismissedAt: number // unix ms of the latest refusal
  dismissals: number // refusals recorded so far
}

function emptyRecord(): PromptRecord {
  return { dismissedAt: 0, dismissals: 0 }
}

function readRecord(): PromptRecord {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return emptyRecord()
    const parsed = JSON.parse(raw) as Partial<PromptRecord>
    return {
      dismissedAt: typeof parsed.dismissedAt === 'number' ? parsed.dismissedAt : 0,
      dismissals: typeof parsed.dismissals === 'number' ? parsed.dismissals : 0,
    }
  } catch {
    return emptyRecord() // corrupt storage reads as fresh
  }
}

function writeRecord(record: PromptRecord): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(record))
  } catch {
    // Persisting dismissals is best effort.
  }
}

// notificationsPromptDue reports whether the offer may surface now: permission
// still undecided and nothing recorded against it. The needs-input moment
// itself is the caller's gate, not a property of state.
export function notificationsPromptDue(permission: NotificationPermission): boolean {
  if (permission !== 'default') return false // denied hides it for good; granted needs none
  const { dismissedAt, dismissals } = readRecord()
  if (dismissals === 0) return true
  if (dismissals > 1) return false // the one retry was spent
  return Date.now() - dismissedAt >= retryAfterMs
}

// dismissNotificationPrompt records one refusal, starting the retry clock.
export function dismissNotificationPrompt(): void {
  const record = readRecord()
  writeRecord({
    dismissedAt: Date.now(),
    dismissals: Math.min(record.dismissals + 1, 2),
  })
}
