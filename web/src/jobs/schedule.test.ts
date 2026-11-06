import { describe, expect, it } from 'vitest'

import {
  formatEvery,
  formatTimestamp,
  intervalToSeconds,
  relativeTimestamp,
  scheduleSummary,
  sortJobsForDisplay,
  splitInterval,
} from './schedule'
import type { Job } from '../api/types'

describe('interval conversion', () => {
  it('converts value and unit into seconds', () => {
    expect(intervalToSeconds(30, 'minutes')).toBe(1800)
    expect(intervalToSeconds(2, 'hours')).toBe(7200)
    expect(intervalToSeconds(1, 'days')).toBe(86400)
    expect(intervalToSeconds(1.5, 'hours')).toBe(5400) // fractional values round
  })

  it('splits stored seconds into the largest whole unit', () => {
    expect(splitInterval(1800)).toEqual({ value: 30, unit: 'minutes' })
    expect(splitInterval(7200)).toEqual({ value: 2, unit: 'hours' })
    expect(splitInterval(172800)).toEqual({ value: 2, unit: 'days' })
    expect(splitInterval(5400)).toEqual({ value: 90, unit: 'minutes' }) // not whole hours
    expect(splitInterval(undefined)).toEqual({ value: 30, unit: 'minutes' })
    // round-trips keep the editor faithful to what is stored
    const split = splitInterval(5400)
    expect(intervalToSeconds(split.value, split.unit)).toBe(5400)
  })

  it('keeps sub-minute intervals in seconds', () => {
    expect(splitInterval(30)).toEqual({ value: 30, unit: 'seconds' })
    expect(splitInterval(90)).toEqual({ value: 90, unit: 'seconds' }) // not whole minutes
    expect(splitInterval(60)).toEqual({ value: 1, unit: 'minutes' })
    expect(intervalToSeconds(30, 'seconds')).toBe(30)
    // the stored value survives an edit round trip instead of rounding to 60
    const split = splitInterval(30)
    expect(intervalToSeconds(split.value, split.unit)).toBe(30)
  })
})

describe('formatEvery', () => {
  it('reads like a sentence with pluralization', () => {
    expect(formatEvery(1800)).toBe('every 30 minutes')
    expect(formatEvery(3600)).toBe('every hour')
    expect(formatEvery(7200)).toBe('every 2 hours')
    expect(formatEvery(86400)).toBe('every day')
    expect(formatEvery(60)).toBe('every minute')
    expect(formatEvery(30)).toBe('every 30 seconds')
    expect(formatEvery(1)).toBe('every second')
  })
})

describe('scheduleSummary', () => {
  const base = {
    scheduleKind: 'interval',
    intervalSeconds: 1800,
    dailyTime: '',
    tz: '',
    nextRunAt: null,
  } satisfies Pick<Job, 'scheduleKind' | 'intervalSeconds' | 'dailyTime' | 'tz' | 'nextRunAt'>

  it('renders intervals in plain language', () => {
    expect(scheduleSummary(base)).toBe('every 30 minutes')
  })

  it('renders daily with an explicit zone', () => {
    expect(scheduleSummary({ ...base, scheduleKind: 'daily', dailyTime: '09:00' })).toBe(
      'daily at 09:00',
    )
    expect(
      scheduleSummary({
        ...base,
        scheduleKind: 'daily',
        dailyTime: '22:30',
        tz: 'Europe/Berlin',
      }),
    ).toBe('daily at 22:30 (Europe/Berlin)')
  })

  it('renders once jobs from their stored slot', () => {
    const summary = scheduleSummary({
      ...base,
      scheduleKind: 'once',
      nextRunAt: new Date('2026-11-06T14:00:00Z').toISOString(),
    })
    expect(summary).toMatch(/^once at /)
  })

  it('appends chosen weekdays to recurring summaries', () => {
    const days = { ...base, weekdays: 'mon,wed,fri' }
    expect(scheduleSummary(days)).toBe('every 30 minutes on Mon, Wed, Fri')
    expect(scheduleSummary({ ...days, scheduleKind: 'daily', dailyTime: '09:00', tz: '' })).toBe(
      'daily at 09:00 on Mon, Wed, Fri',
    )
    // no restriction reads exactly as before
    expect(scheduleSummary(base)).toBe('every 30 minutes')
  })

  it('renders unknown kinds verbatim', () => {
    expect(scheduleSummary({ ...base, scheduleKind: 'weekly' as never })).toBe('weekly')
  })
})

describe('formatTimestamp', () => {
  const iso = '2026-11-05T14:19:00Z'

  // the abbreviation the runtime itself renders for a zone, so assertions
  // hold in any viewer zone and locale
  function zoneFor(tz?: string): string {
    return (
      new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(new Date(iso))
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
    )
  }

  it('appends the viewer zone abbreviation', () => {
    const bare = new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(formatTimestamp(iso)).toBe(`${bare} ${zoneFor()}`)
  })

  it('renders a job-owned zone when one rides along', () => {
    const bare = new Date(iso).toLocaleString(undefined, {
      timeZone: 'Europe/Berlin',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(formatTimestamp(iso, 'Europe/Berlin')).toBe(`${bare} ${zoneFor('Europe/Berlin')}`)
  })

  it('falls back for missing stamps and passes unreadable ones through', () => {
    expect(formatTimestamp(undefined)).toBe('—')
    expect(formatTimestamp('not a date')).toBe('not a date')
  })
})

describe('relativeTimestamp', () => {
  const NOW = Date.parse('2026-11-05T12:00:00Z')
  const ago = (mins: number): string => new Date(NOW - mins * 60_000).toISOString()

  it('renders recency like the rewind picker', () => {
    expect(relativeTimestamp(new Date(NOW).toISOString(), NOW)).toBe('0s ago')
    expect(relativeTimestamp(ago(1), NOW)).toBe('1m ago')
    expect(relativeTimestamp(ago(96), NOW)).toBe('96m ago')
    expect(relativeTimestamp(ago(3 * 60), NOW)).toBe('3h ago')
    expect(relativeTimestamp(ago(26 * 60), NOW)).toBe('1d ago')
    expect(relativeTimestamp(ago(6 * 24 * 60), NOW)).toBe('6d ago')
  })

  it('falls back to a short date past a week', () => {
    const ts = NOW - 8 * 86_400_000
    expect(relativeTimestamp(new Date(ts).toISOString(), NOW)).toBe(
      new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    )
  })

  it('clamps future stamps and drops unreadable ones', () => {
    expect(relativeTimestamp(new Date(NOW + 5_000).toISOString(), NOW)).toBe('0s ago')
    expect(relativeTimestamp('not a date', NOW)).toBe('—')
    expect(relativeTimestamp(undefined, NOW)).toBe('—')
  })
})

describe('sortJobsForDisplay', () => {
  const base = {
    name: '',
    workspace: '/repo',
    spawnMode: 'new',
    enabled: true,
    scheduleKind: 'interval',
    intervalSeconds: 60,
    onMissed: 'skip',
    overlap: 'run',
    keepAlive: false,
    createdAt: '2026-11-01T00:00:00Z',
  } satisfies Omit<Job, 'id'>

  function job(id: number, overrides: Partial<Job> = {}): Job {
    return { ...base, id, name: `job ${id}`, ...overrides }
  }

  it('sorts scheduled rows soonest first', () => {
    const sorted = sortJobsForDisplay([
      job(3, { nextRunAt: '2026-11-07T09:00:00Z' }),
      job(1, { nextRunAt: '2026-11-06T10:00:00Z' }),
      job(2, { nextRunAt: '2026-11-06T12:00:00Z' }),
    ])
    expect(sorted.map((j) => j.id)).toEqual([1, 2, 3])
  })

  it('sinks disabled rows below scheduled ones', () => {
    // job 4's slot is earlier, but disabled alone decides the row sinks
    const sorted = sortJobsForDisplay([
      job(4, { enabled: false, nextRunAt: '2026-11-06T08:00:00Z' }),
      job(5, { nextRunAt: '2026-11-07T09:00:00Z' }),
    ])
    expect(sorted.map((j) => j.id)).toEqual([5, 4])
  })

  it('sinks null and unparseable fire times', () => {
    const sorted = sortJobsForDisplay([
      job(6, { nextRunAt: 'not a date' }),
      job(7, { nextRunAt: null }),
      job(8, { nextRunAt: '2026-11-06T10:00:00Z' }),
      job(9),
    ])
    // the unscheduled tail keeps its stored order
    expect(sorted.map((j) => j.id)).toEqual([8, 6, 7, 9])
  })

  it('breaks equal fire times by id', () => {
    const slot = '2026-11-06T10:00:00Z'
    const sorted = sortJobsForDisplay([job(12, { nextRunAt: slot }), job(11, { nextRunAt: slot })])
    expect(sorted.map((j) => j.id)).toEqual([11, 12])
  })

  it('sorts a copy and leaves the input untouched', () => {
    const input = [
      job(14, { nextRunAt: '2026-11-07T09:00:00Z' }),
      job(13, { enabled: false }),
      job(15, { nextRunAt: '2026-11-06T10:00:00Z' }),
    ]
    const before = [...input]

    const sorted = sortJobsForDisplay(input)

    expect(sorted).not.toBe(input)
    expect(sorted.map((j) => j.id)).toEqual([15, 14, 13])
    expect(input).toEqual(before)
  })
})
