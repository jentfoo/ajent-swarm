import { describe, expect, it } from 'vitest'

import {
  defaultDraft,
  draftFromJob,
  duplicateDraft,
  localInputToDate,
  maxNameLen,
  maxTriggerLen,
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

  it('counts name length in bytes like the server', () => {
    // 199 ASCII plus one emoji passes the UTF-16 count but exceeds 200 bytes
    const passesUtf16 = {
      ...defaultDraft(),
      workspace: '/repo',
      name: 'x'.repeat(199) + '\u{1F600}',
    }
    expect([...passesUtf16.name].length).toBeLessThanOrEqual(maxNameLen)
    expect(validateDraft(passesUtf16)).toHaveProperty('name')

    const fitsInBytes = { ...defaultDraft(), workspace: '/repo', name: 'x'.repeat(199) + 'y' }
    expect(validateDraft(fitsInBytes)).toEqual({})
  })

  it('counts trigger command length in bytes like the server', () => {
    const emoji = '\u{1F600}' // four UTF-8 bytes per emoji
    const tooBig = {
      ...defaultDraft(),
      workspace: '/repo',
      triggerCommand: emoji.repeat(501),
    }
    expect(validateDraft(tooBig)).toHaveProperty('triggerCommand')

    const fitsInBytes = {
      ...defaultDraft(),
      name: 'job',
      workspace: '/repo',
      triggerCommand: 'x'.repeat(maxTriggerLen),
    }
    expect(validateDraft(fitsInBytes)).toEqual({})
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

  it('keeps sub-minute intervals through an edit round trip', () => {
    const draft = draftFromJob({ ...stored, scheduleKind: 'interval', intervalSeconds: 30 })
    expect(draft.intervalValue).toBe(30)
    expect(draft.intervalUnit).toBe('seconds')
    expect(toPayload(draft, stored.id).intervalSeconds).toBe(30)
  })
})

describe('duplicateDraft', () => {
  it('copies a row verbatim with the seeded adjustments', () => {
    const draft = duplicateDraft(stored)
    expect(draft).toEqual({ ...draftFromJob(stored), name: 'Copy of nightly', enabled: false })
    // the copy opens ready to save under the client's own validation
    expect(validateDraft(draft)).toEqual({})
  })

  it('clips the copied name to the server byte bound', () => {
    const emoji = '\u{1F600}' // four UTF-8 bytes per emoji
    const draft = duplicateDraft({ ...stored, name: emoji.repeat(80) })
    expect(validateDraft(draft)).toEqual({})
    // 'Copy of ' spends 8 of the 200 bytes, the rest fills with whole emojis
    expect([...draft.name]).toHaveLength(8 + 48)

    const ascii = duplicateDraft({ ...stored, name: 'y'.repeat(300) })
    expect([...ascii.name]).toHaveLength(maxNameLen)
  })

  it('clears a one shot slot but keeps recurring fields', () => {
    const once = duplicateDraft({ ...stored, scheduleKind: 'once' })
    expect(once.onceAt).toBe('')

    const daily = duplicateDraft(stored)
    expect(daily.onceAt).not.toBe('') // the stored next slot still round-trips
    expect(daily.dailyTime).toBe('09:00')
  })
})

describe('trigger fields', () => {
  it('round-trips weekdays through the payload in canonical order', () => {
    const draft = { ...defaultDraft(), weekdays: ['fri', 'mon'] as const }
    const payload = toPayload(draft as never)
    expect(payload.weekdays).toBe('mon,fri')
    // once jobs never carry a weekday restriction
    const once = toPayload({ ...draft, scheduleKind: 'once' } as never)
    expect(once.weekdays).toBeUndefined()
  })

  it('parses stored weekdays and ignores unknown tokens', () => {
    const job = { ...stored, weekdays: 'wed,sat,bogus' }
    const draft = draftFromJob(job)
    expect(draft.weekdays).toEqual(['wed', 'sat'])
  })

  it('carries the trigger command fields into the payload', () => {
    const draft = {
      ...defaultDraft(),
      triggerCommand: ' git pull ',
      triggerOn: 'error' as const,
      runWhenIdle: true,
      idleMaxDelaySeconds: -5,
    }
    const payload = toPayload(draft)
    expect(payload.triggerCommand).toBe(' git pull ') // trimmed server-side
    expect(payload.triggerOn).toBe('error')
    expect(payload.runWhenIdle).toBe(true)
    expect(payload.idleMaxDelaySeconds).toBe(0) // negative clamps to wait forever
  })

  it('flags an oversized trigger command', () => {
    const draft = { ...defaultDraft(), triggerCommand: 'x'.repeat(2001) }
    expect(validateDraft(draft)).toHaveProperty('triggerCommand')
  })
})
