import type { RewindKind } from '../api/types'

// Rewind rows speak one visual language on every surface: a kind tag (or its
// color on a dot), the row label, and a relative age. These helpers are the
// single transcription of that agreement, so the desktop tree and the mobile
// flat list never drift apart.

// kindLabel names one rewind row's kind the way both pickers read it.
export function kindLabel(kind: RewindKind): string {
  switch (kind) {
    case 'user':
      return 'prompt'
    case 'assistant':
      return 'reply'
    case 'compaction':
      return 'compaction'
    default:
      return kind
  }
}

// kindClass colors a row after ajent's marks: prompts carry the accent, replies
// read as plain text, compactions and unknown kinds stay muted.
export function kindClass(kind: RewindKind): string {
  switch (kind) {
    case 'user':
      return 'kind-user'
    case 'assistant':
      return 'kind-assistant'
    default:
      return 'kind-compaction'
  }
}

// relativeTime renders a candidate's age, e.g. "96m ago"; minutes keep their
// precision through the first two hours, past a week it falls back to a short
// date, unreadable stamps stay empty.
export function relativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return ''
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 120) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// absoluteTime renders a candidate's full local stamp for row tooltips.
export function absoluteTime(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  return new Date(ts).toLocaleString()
}
