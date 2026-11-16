import { describe, expect, it } from 'vitest'

import { filterModelGroups } from './modelFilter'
import { providerGroups } from './modelGroups'
import type { ModelState } from '../api/types'

const model = (key: string, short = ''): ModelState => ({
  key,
  short,
  window: 0,
  caps: { reasoning: false, images: false, parallelToolCalls: false },
})

const registry = () => [
  model('anthropic/claude-sonnet', 'sonnet'),
  model('anthropic/claude-haiku', 'haiku'),
  model('openai/gpt-4o', '4o'),
  model('local-tuned'),
]

const keys = (ms: ModelState[]) => ms.map((m) => m.key)

// The one matching rule every model menu filter shares: case-insensitive
// substring across provider, full key and `short`, groups with no surviving
// child dropping out, loose keys matching on the key alone, and a blank query
// passing the whole registry through.
describe('filterModelGroups', () => {
  it('passes the registry through for a blank query', () => {
    const listing = registry()
    expect(filterModelGroups('', listing)).toEqual(providerGroups(listing))
    expect(filterModelGroups('   ', listing)).toEqual(providerGroups(listing))
  })

  it('matches keys and shorts case-insensitively', () => {
    const byKey = filterModelGroups('CLAUDE-HAIKU', registry())
    expect(byKey.groups.map((g) => g.provider)).toEqual(['anthropic'])
    expect(keys(byKey.groups[0]!.models)).toEqual(['anthropic/claude-haiku'])
    expect(byKey.loose).toEqual([])

    const byShort = filterModelGroups('4O', registry())
    expect(byShort.groups.map((g) => g.provider)).toEqual(['openai'])
    expect(keys(byShort.groups[0]!.models)).toEqual(['openai/gpt-4o'])
  })

  it('keeps every child of a provider whose name matches', () => {
    const { groups, loose } = filterModelGroups('anthropic', registry())
    expect(groups).toHaveLength(1)
    expect(keys(groups[0]!.models)).toEqual(['anthropic/claude-sonnet', 'anthropic/claude-haiku'])
    expect(loose).toEqual([])
  })

  it('drops groups with no matching child and keeps order', () => {
    const { groups, loose } = filterModelGroups('haiku', registry())
    expect(groups.map((g) => g.provider)).toEqual(['anthropic'])
    expect(keys(groups[0]!.models)).toEqual(['anthropic/claude-haiku'])
    expect(loose).toEqual([])
  })

  it('matches loose models on the key only', () => {
    const { groups, loose } = filterModelGroups('gpt', [
      model('local-tuned', 'gpt-tuned'),
      model('bare-gpt'),
    ])
    expect(groups).toEqual([])
    expect(keys(loose)).toEqual(['bare-gpt'])
  })

  it('answers empty groups and loose rows when nothing matches', () => {
    expect(filterModelGroups('zzz', registry())).toEqual({ groups: [], loose: [] })
  })
})
