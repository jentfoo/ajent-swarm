import { describe, expect, it } from 'vitest'

import { absoluteTime, kindClass, kindLabel, relativeTime } from './rewind'

const NOW = Date.parse('2026-11-05T12:00:00Z')

describe('rewind row helpers', () => {
  it('labels kinds', () => {
    expect(kindLabel('user')).toBe('prompt')
    expect(kindLabel('assistant')).toBe('reply')
    expect(kindLabel('compaction')).toBe('compaction')
  })

  it('colors kinds after ajent marks', () => {
    expect(kindClass('user')).toBe('kind-user')
    expect(kindClass('assistant')).toBe('kind-assistant')
    expect(kindClass('compaction')).toBe('kind-compaction')
  })

  it('renders relative ages', () => {
    expect(relativeTime(NOW, NOW)).toBe('0s ago')
    expect(relativeTime(NOW - 59_000, NOW)).toBe('59s ago')
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1m ago')
    expect(relativeTime(NOW - 96 * 60_000, NOW)).toBe('96m ago')
    expect(relativeTime(NOW - 119 * 60_000, NOW)).toBe('119m ago')
    expect(relativeTime(NOW - 120 * 60_000, NOW)).toBe('2h ago')
    expect(relativeTime(NOW - 26 * 3_600_000, NOW)).toBe('1d ago')
    expect(relativeTime(NOW - 6 * 86_400_000, NOW)).toBe('6d ago')
  })

  it('falls back to a short date past a week', () => {
    const ts = NOW - 8 * 86_400_000
    expect(relativeTime(ts, NOW)).toBe(
      new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    )
  })

  it('clamps future stamps and drops unreadable ones', () => {
    expect(relativeTime(NOW + 5_000, NOW)).toBe('0s ago')
    expect(relativeTime(Number.NaN, NOW)).toBe('')
    expect(absoluteTime(Number.NaN)).toBe('')
  })
})
