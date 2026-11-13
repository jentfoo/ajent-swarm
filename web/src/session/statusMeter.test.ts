import { describe, expect, it } from 'vitest'

import {
  contextBudget,
  contextCount,
  contextLevel,
  contextPct,
  contextTitle,
  formatTokens,
  usageTitle,
} from './statusMeter'
import type { ContextData, UsageData, UsageState } from '../api/types'

// The status bar's numeric facts: the meter fills against the compaction
// budget when one exists, escalation rides the same denominator, the count
// abbreviates used over the real window with `~` marking estimates, and the
// tooltips carry the fuller breakdowns.

function ctx(over: Partial<ContextData> = {}): ContextData {
  return {
    used: 100_000,
    window: 200_000,
    reserve: 10_000,
    compact: 150_000,
    estimated: false,
    ...over,
  }
}

function usageData(over: Partial<UsageData> = {}): UsageData {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...over }
}

describe('contextBudget', () => {
  it.each([
    ['compaction budget wins', 150_000, { compact: 150_000 }],
    ['unset falls to window', 200_000, { compact: 0 }],
    ['negative falls to window', 200_000, { compact: -1 }],
  ])('%s', (_name, want, over) => {
    expect(contextBudget(ctx(over))).toBe(want)
  })
})

describe('contextLevel', () => {
  it.each([
    ['empty before warn', '', { used: 104_999 }],
    ['warn at seven tenths', 'warn', { used: 105_000 }],
    ['warn below danger', 'warn', { used: 134_999 }],
    ['danger at nine tenths', 'danger', { used: 135_000 }],
    ['danger past the budget', 'danger', { used: 160_000 }],
    ['window denominates without compact', '', { compact: 0, used: 139_999 }],
    ['warn against the window', 'warn', { compact: 0, used: 140_000 }],
    ['danger against the window', 'danger', { compact: 0, used: 180_000 }],
    ['unknown window stays plain', '', { window: 0 }],
    ['unused context stays plain', '', { used: 0 }],
  ])('%s', (_name, want, over) => {
    expect(contextLevel(ctx(over))).toBe(want)
  })
})

describe('contextPct', () => {
  it.each([
    ['fill tracks the budget', { used: 75_000 }, 50],
    ['fill tracks the window', { compact: 0, used: 100_000 }, 50],
    ['fills at the budget', { used: 150_000 }, 100],
    ['clamps past the budget', { used: 300_000 }, 100],
    ['unknown window is empty', { window: 0, compact: 0, used: 5_000 }, 0],
  ])('%s', (_name, over, want) => {
    expect(contextPct(ctx(over))).toBeCloseTo(want)
  })
})

describe('contextCount', () => {
  it.each([
    ['abbreviates both sides', '100k/200k', { used: 100_000 }],
    ['rounds down to one decimal', '100.2k/200k', { used: 100_240 }],
    ['marks estimates', '~100k/200k', { used: 100_000, estimated: true }],
    ['keeps small counts plain', '950/200k', { used: 950 }],
    ['counts zero used', '0/200k', { used: 0 }],
  ])('%s', (_name, want, over) => {
    expect(contextCount(ctx(over))).toBe(want)
  })
})

describe('contextTitle', () => {
  it('names the compaction line', () => {
    expect(contextTitle(ctx())).toBe('context 100,000/200,000 tokens, compacts at 150,000')
  })

  it('marks estimates and skips an unset budget', () => {
    const title = contextTitle(ctx({ compact: 0, used: 1_005, estimated: true }))
    expect(title).toBe('context ~1,005/200,000 tokens')
  })
})

describe('formatTokens', () => {
  it.each([
    ['plain under a thousand', 950, '950'],
    ['thousands to one decimal', 12_345, '12.3k'],
    ['drops trailing zero', 200_000, '200k'],
    ['millions suffixed', 1_234_567, '1.2M'],
    ['drops the million zero', 1_000_000, '1M'],
  ])('%s', (_name, n, want) => {
    expect(formatTokens(n)).toBe(want)
  })
})

describe('usageTitle', () => {
  it('totals input and output', () => {
    const u: UsageState = {
      turns: 3,
      total: usageData({ input: 12_000, output: 5_000 }),
      child: usageData(),
      estimatedTurns: 0,
    }
    expect(usageTitle(u)).toBe('12,000 in / 5,000 out')
  })

  it('splits cache and reasoning when nonzero', () => {
    const u: UsageState = {
      turns: 3,
      total: usageData({ input: 12_000, output: 5_000, cacheRead: 8_000, reasoning: 900 }),
      child: usageData(),
      estimatedTurns: 0,
    }
    expect(usageTitle(u)).toBe('12,000 in / 5,000 out\ncache 8,000 read / 0 write\n900 reasoning')
  })

  it('adds child spend when sub-agents spent', () => {
    const u: UsageState = {
      turns: 3,
      total: usageData({ input: 12_000, output: 5_000 }),
      child: usageData({ input: 4_000, output: 2_000 }),
      estimatedTurns: 0,
    }
    expect(usageTitle(u)).toBe('12,000 in / 5,000 out\nsub-agents 4,000 in / 2,000 out')
  })

  it('hides child spend when it is zero', () => {
    const u: UsageState = {
      turns: 3,
      total: usageData({ input: 1, output: 2 }),
      child: usageData(),
      estimatedTurns: 0,
    }
    expect(usageTitle(u)).not.toContain('sub-agents')
  })

  it('hides cache write when only read ran', () => {
    const u: UsageState = {
      turns: 3,
      total: usageData({ input: 1, output: 2, cacheWrite: 3_000 }),
      child: usageData(),
      estimatedTurns: 0,
    }
    expect(usageTitle(u)).toBe('1 in / 2 out\ncache 0 read / 3,000 write')
  })
})
