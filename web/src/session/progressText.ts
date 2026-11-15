import type { ToolProgressView } from '../state/eventApplier'

// Compose progress mirrors upstream's TUI activity row for a call the model is
// still building ("132 lines · 4.1kb"), so one in-flight call reads the same on
// either surface.

// progressText renders a composing call's streamed size, the line count dropped
// while none accumulated and '' before anything has streamed.
export function progressText(p: ToolProgressView): string {
  const parts: string[] = []
  if ((p.lines ?? 0) > 0) parts.push(`${p.lines} lines`)
  const bytes = p.bytes ?? 0
  if (bytes > 0) parts.push(humanSize(bytes))
  return parts.join(' · ')
}

// humanSize abbreviates a byte count as 259b, 3.5kb or 1.2mb: binary units, one
// decimal place, trailing .0 dropped. Quantities just below 1mb round up to mb,
// so nothing renders as "1024kb". Matches upstream's strutil.HumanSize.
function humanSize(n: number): string {
  const kb = 1024
  const mb = kb * kb
  if (n >= mb || n / kb >= kb - 0.05) return trimZero((n / mb).toFixed(1)) + 'mb'
  if (n >= kb) return trimZero((n / kb).toFixed(1)) + 'kb'
  return `${n}b`
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}
