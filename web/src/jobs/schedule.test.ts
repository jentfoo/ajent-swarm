import { describe, expect, it } from 'vitest'

import { formatEvery, intervalToSeconds, scheduleSummary, splitInterval } from './schedule'
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
})

describe('formatEvery', () => {
  it('reads like a sentence with pluralization', () => {
    expect(formatEvery(1800)).toBe('every 30 minutes')
    expect(formatEvery(3600)).toBe('every hour')
    expect(formatEvery(7200)).toBe('every 2 hours')
    expect(formatEvery(86400)).toBe('every day')
    expect(formatEvery(60)).toBe('every minute')
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
