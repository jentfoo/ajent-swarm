import { describe, expect, it } from 'vitest'

import { isPermitDialog, permitChoices, pickPermitOption, reasonAskDeny } from './decisionNote'
import type { InteractionPending } from '../api/types'

// Matching keys on the barrier's rendered labels, not the kind hint, and
// tolerates wording drift case-insensitively (decisionNote.ts).

const withOptions = (options?: string[]): InteractionPending => ({
  id: 1,
  kind: 'decision',
  prompt: 'Allow `rm` tool call?',
  options,
})

describe('isPermitDialog', () => {
  const cases: { name: string; options?: string[]; want: boolean }[] = [
    {
      name: 'matches barrier option labels',
      options: ['Allow', 'Allow with note', 'Allow `rm` for session', 'Deny'],
      want: true,
    },
    {
      name: 'matches without session memory',
      options: ['Allow', 'Allow with note', 'Deny'],
      want: true,
    },
    {
      name: 'matches case insensitively',
      options: ['ALLOW WITH NOTE', 'deny'],
      want: true,
    },
    { name: 'rejects non permit options', options: ['yes', 'no'], want: false },
    { name: 'rejects plain confirm options', options: ['Approve', 'Reject'], want: false },
    { name: 'false without options', want: false },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(isPermitDialog(withOptions(tc.options))).toBe(tc.want)
    })
  }
})

describe('reasonAskDeny', () => {
  const cases: { name: string; prompt: string; want: boolean | undefined }[] = [
    { name: 'deny reason ask reads deny', prompt: 'reason for denying', want: true },
    { name: 'allow note ask reads allow', prompt: 'note for allowing', want: false },
    { name: 'matches case and padding drift', prompt: 'Add a Reason For Denying:', want: true },
    { name: 'rejects unrelated prompts', prompt: 'Pick a branch to restore', want: undefined },
    { name: 'rejects empty prompt', prompt: '', want: undefined },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(reasonAskDeny(tc.prompt)).toBe(tc.want)
    })
  }
})

const plainPermit = ['Allow', 'Allow with note', 'Deny']
const sessionPermit = ['Allow', 'Allow with note', 'Allow `rm` for session', 'Deny']

describe('permitChoices', () => {
  it('hides allow-with-note keeping answer indexes', () => {
    expect(permitChoices(plainPermit)).toEqual([
      { label: 'Allow', index: 0 },
      { label: 'Deny', index: 2 },
    ])
  })

  it('keeps the session option beside allow and deny', () => {
    expect(permitChoices(sessionPermit)).toEqual([
      { label: 'Allow', index: 0 },
      { label: 'Allow `rm` for session', index: 2 },
      { label: 'Deny', index: 3 },
    ])
  })

  it('hides case-insensitive wording drift', () => {
    expect(permitChoices(['allow', 'ALLOW WITH NOTE', 'deny'])).toEqual([
      { label: 'allow', index: 0 },
      { label: 'deny', index: 2 },
    ])
  })
})

describe('pickPermitOption', () => {
  it('deny records a denial intent even bare', () => {
    expect(pickPermitOption(plainPermit, 2, '')).toEqual({ index: 2, deny: true })
  })

  it('bare allow answers as-is with no intent', () => {
    expect(pickPermitOption(plainPermit, 0, '')).toEqual({ index: 0 })
  })

  it('typed note rides allow as allow-with-note', () => {
    expect(pickPermitOption(plainPermit, 0, 'only inside build/')).toEqual({
      index: 1,
      deny: false,
    })
  })

  it('session allow ignores a typed note', () => {
    expect(pickPermitOption(sessionPermit, 2, 'one off')).toEqual({ index: 2 })
  })

  it('answers plainly without an allow-with-note option', () => {
    expect(pickPermitOption(['Allow', 'Deny'], 0, 'note')).toEqual({ index: 0 })
  })
})
