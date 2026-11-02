import { describe, expect, it } from 'vitest'

import {
  defaultDraft,
  draftFromJob,
  localInputToDate,
  toPayload,
  validateDraft,
  validDailyTime,
  validSessionName,
} from './jobDraft'
import type { Job } from '../api/types'

const stored: Job = {
  id: 7,
  name: 'nightly',
  workspace: '/repo',
  commandPrefix: '',
  prompt: 'sweep the logs',
  spawnMode: 'new',
  enabled: true,
  scheduleKind: 'daily',
  dailyTime: '09:00',
  tz: 'UTC',
  nextRunAt: '2026-11-07T09:00:00Z',
  onMissed: 'skip',
  overlap: 'run',
  timeoutMinutes: 0,
  keepAlive: false,
  createdAt: '2026-11-01T00:00:00Z',
}

describe('validateDraft', () => {
  it('accepts a filled draft', () => {
    const draft = { ...defaultDraft(), name: 'job', workspace: '/repo' }
    expect(validateDraft(draft)).toEqual({})
  })

  it('mirrors the backend field rules per field', () => {
    const cases: Array<{
      name: string
      mutate: (d: ReturnType<typeof defaultDraft>) => void
      field: string
    }> = [
      { name: 'empty_name', mutate: (d) => void (d.name = '   '), field: 'name' },
      { name: 'long_name', mutate: (d) => void (d.name = 'x'.repeat(201)), field: 'name' },
      { name: 'missing_workspace', mutate: (d) => void (d.workspace = ''), field: 'workspace' },
      {
        name: 'resume_needs_target',
        mutate: (d) => void ((d.spawnMode = 'resume'), (d.sessionTarget = '')),
        field: 'sessionTarget',
      },
      {
        name: 'session_rejects_bad_name',
        mutate: (d) => void ((d.spawnMode = 'session'), (d.sessionTarget = '-nope')),
        field: 'sessionTarget',
      },
      {
        name: 'once_needs_slot',
        mutate: (d) => void ((d.scheduleKind = 'once'), (d.onceAt = '')),
        field: 'onceAt',
      },
      {
        name: 'interval_must_be_positive',
        mutate: (d) => void ((d.intervalValue = 0), (d.intervalUnit = 'minutes')),
        field: 'interval',
      },
      {
        name: 'interval_too_large',
        mutate: (d) => void ((d.intervalValue = 400), (d.intervalUnit = 'days')),
        field: 'interval',
      },
      {
        name: 'bad_daily_time',
        mutate: (d) => void ((d.scheduleKind = 'daily'), (d.dailyTime = '25:00')),
        field: 'dailyTime',
      },
      {
        name: 'negative_timeout',
        mutate: (d) => void (d.timeoutMinutes = -1),
        field: 'timeoutMinutes',
      },
    ]
    for (const tt of cases) {
      const draft = defaultDraft()
      tt.mutate(draft)
      expect(Object.keys(validateDraft(draft))).toContain(tt.field)
    }
  })

  it('accepts one-digit daily times like the backend', () => {
    expect(validDailyTime('7:05')).toBe(true)
    expect(validDailyTime('09:60')).toBe(false)
    expect(validDailyTime('0900')).toBe(false)
    expect(validDailyTime('9:')).toBe(false)
  })

  it('validates session names by ajent charset', () => {
    expect(validSessionName('fix-auth/2.0_x')).toBe(true)
    expect(validSessionName('-lead')).toBe(false)
    expect(validSessionName('has space')).toBe(false)
    expect(validSessionName('')).toBe(false)
  })
})

describe('toPayload', () => {
  it('maps interval drafts onto stored seconds', () => {
    const draft = {
      ...defaultDraft(),
      name: 'j',
      workspace: '/w',
      intervalValue: 2,
      intervalUnit: 'hours' as const,
    }
    expect(toPayload(draft).intervalSeconds).toBe(7200)
  })

  it('converts once slots into ISO timestamps', () => {
    const draft = { ...defaultDraft(), scheduleKind: 'once' as const, onceAt: '2026-11-06T14:00' }
    const payload = toPayload(draft)
    expect(payload.nextRunAt).toBe(new Date('2026-11-06T14:00').toISOString())
  })

  it('keeps identity and anchor facts when editing', () => {
    const draft = draftFromJob(stored)
    const payload = toPayload(draft, stored.id)
    expect(payload.id).toBe(7)
    // recurring rows never carry nextRunAt, so an update recomputes the slot
    expect('nextRunAt' in payload).toBe(false)
  })
})

describe('draftFromJob', () => {
  it('round-trips a stored row into editable fields and back', () => {
    const draft = draftFromJob(stored)
    expect(draft.name).toBe('nightly')
    expect(draft.dailyTime).toBe('09:00')
    expect(draft.tz).toBe('UTC')

    const payload = toPayload(draft, stored.id) as Record<string, unknown>
    for (const key of [
      'name',
      'workspace',
      'prompt',
      'scheduleKind',
      'dailyTime',
      'tz',
      'enabled',
    ]) {
      expect(payload[key]).toBe(stored[key as keyof Job])
    }
  })

  it('seeds once slots as local input values', () => {
    const draft = draftFromJob({ ...stored, scheduleKind: 'once' })
    const parsed = localInputToDate(draft.onceAt)
    expect(parsed?.getTime()).toBe(new Date(stored.nextRunAt!).getTime())
  })
})
