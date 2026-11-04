import { describe, expect, it } from 'vitest'

import { denyAskOption, isPermitDialog, matchesReasonAsk, noteAskOption } from './decisionNote'
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

describe('matchesReasonAsk', () => {
  const cases: { name: string; prompt: string; want: boolean }[] = [
    { name: 'matches deny reason ask', prompt: 'reason for denying', want: true },
    { name: 'matches allow note ask', prompt: 'note for allowing', want: true },
    { name: 'matches case and padding drift', prompt: 'Add a Reason For Denying:', want: true },
    { name: 'rejects unrelated prompts', prompt: 'Pick a branch to restore', want: false },
    { name: 'rejects empty prompt', prompt: '', want: false },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(matchesReasonAsk(tc.prompt)).toBe(tc.want)
    })
  }
})

describe('noteAskOption', () => {
  const cases: { name: string; label: string; want: boolean }[] = [
    { name: 'allow with note opens ask', label: 'Allow with note', want: true },
    { name: 'deny opens ask', label: 'Deny', want: true },
    { name: 'deny wording drift opens ask', label: 'Deny this call', want: true },
    { name: 'plain allow never opens ask', label: 'Allow', want: false },
    { name: 'session allow never opens ask', label: 'Allow `git push` for session', want: false },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(noteAskOption(tc.label)).toBe(tc.want)
    })
  }
})

describe('denyAskOption', () => {
  const cases: { name: string; label: string; want: boolean }[] = [
    { name: 'deny means denial reason', label: 'Deny', want: true },
    { name: 'allow with note means note', label: 'Allow with note', want: false },
    { name: 'session allow means note', label: 'Allow `rm` for session', want: false },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(denyAskOption(tc.label)).toBe(tc.want)
    })
  }
})
