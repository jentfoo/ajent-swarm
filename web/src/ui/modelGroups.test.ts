import { describe, expect, it } from 'vitest'

import { providerGroups } from './modelGroups'
import type { ModelState } from '../api/types'

const model = (key: string): ModelState => ({
  key,
  short: '',
  window: 0,
  caps: { reasoning: false, images: false, parallelToolCalls: false },
})

// The one grouping rule every model menu shares: provider is the key prefix
// before its first slash, providers keep first-appearance order, and bare or
// leading-slash keys come back loose.
describe('providerGroups', () => {
  it('groups keys by the prefix before the first slash', () => {
    const { groups, loose } = providerGroups([
      model('anthropic/sonnet'),
      model('anthropic/haiku'),
      model('openai/gpt'),
    ])
    expect(groups.map((g) => g.provider)).toEqual(['anthropic', 'openai'])
    expect(groups[0]!.models.map((m) => m.key)).toEqual(['anthropic/sonnet', 'anthropic/haiku'])
    expect(groups[1]!.models.map((m) => m.key)).toEqual(['openai/gpt'])
    expect(loose).toEqual([])
  })

  it('keeps providers in first-appearance order', () => {
    const { groups } = providerGroups([
      model('b/one'),
      model('a/two'),
      model('b/three'),
      model('c/four'),
    ])
    expect(groups.map((g) => g.provider)).toEqual(['b', 'a', 'c'])
    expect(groups[1]!.models.map((m) => m.key)).toEqual(['a/two'])
  })

  it('returns bare keys loose in listing order', () => {
    const { groups, loose } = providerGroups([model('anthropic/sonnet'), model('local-tuned')])
    expect(groups.map((g) => g.provider)).toEqual(['anthropic'])
    expect(loose.map((m) => m.key)).toEqual(['local-tuned'])
  })

  it('returns leading-slash keys loose', () => {
    const { groups, loose } = providerGroups([model('/weird'), model('ok/one')])
    expect(groups.map((g) => g.provider)).toEqual(['ok'])
    expect(loose.map((m) => m.key)).toEqual(['/weird'])
  })

  it('groups a nested key under its first segment only', () => {
    const { groups, loose } = providerGroups([model('azure/openai/gpt-4o')])
    expect(groups[0]!.provider).toBe('azure')
    expect(groups[0]!.models.map((m) => m.key)).toEqual(['azure/openai/gpt-4o'])
    expect(loose).toEqual([])
  })

  it('answers empty groups and loose rows for an empty listing', () => {
    expect(providerGroups([])).toEqual({ groups: [], loose: [] })
  })
})
