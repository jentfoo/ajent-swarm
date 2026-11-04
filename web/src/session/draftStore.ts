// Per-session composer drafts persisted in localStorage, keyed by sessionId.
// Every change writes through, so a reload, an auth round trip or a session
// switch finds the text where typing left off; clearing happens only when a
// submit is accepted (composer-draft-policy.md). Reads and writes are best
// effort: corrupt storage, quota pressure and privacy modes degrade to drafts
// that merely live shorter.

const storageKey = 'swarm.drafts.v1'

// Oversize drafts skip persistence; the bound keeps one runaway draft from
// pressuring the localStorage quota shared with every other store.
const maxStoredChars = 512 * 1024

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [id, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof text === 'string') out[id] = text
    }
    return out
  } catch {
    return {} // corrupt storage reads as fresh
  }
}

// One read per page load; writes keep the map current, so views can remount
// without re-parsing storage.
const drafts = new Map<string, string>()
function reload(): void {
  drafts.clear()
  for (const [id, text] of Object.entries(readAll())) drafts.set(id, text)
}
reload()

function persist(): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(drafts)))
  } catch {
    // Persisting drafts is best effort.
  }
}

export function readDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? ''
}

// writeDraft stores one session's draft; an empty text drops the key. Oversize
// texts stay in memory but skip persistence rather than truncating: a silently
// cut draft could send the wrong text, while an unpersisted one only loses its
// reload safety.
export function writeDraft(sessionId: string, text: string): void {
  let changed = false
  if (text === '') {
    changed = drafts.delete(sessionId)
  } else if (drafts.get(sessionId) !== text) {
    drafts.set(sessionId, text)
    changed = true
  }
  if (changed && text.length <= maxStoredChars) persist()
}

// prependDraft mirrors upstream PrependInput: incoming text lands above a
// non-empty draft separated by one newline, and an empty draft takes it whole.
export function prependDraft(current: string, incoming: string): string {
  if (current === '') return incoming
  return `${incoming}\n${current}`
}

// resetDrafts simulates a fresh page load: cached state is dropped and the
// store re-reads what storage actually holds, which keeps tests isolated once
// localStorage was cleared underneath them.
export function resetDrafts(): void {
  reload()
}
