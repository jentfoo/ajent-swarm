import { providerGroups } from './modelGroups'
import type { ModelState } from '../api/types'

// one provider bucket plus the loose rows, exactly as providerGroups answers
type GroupedModels = ReturnType<typeof providerGroups>

// filterModelGroups narrows a models.get registry by a case-insensitive
// substring query across each key's provider, full key and `short` label.
// Groups with no surviving child drop out, loose keys match on the key alone,
// and a blank query returns the grouping unchanged.
export function filterModelGroups(query: string, models: ModelState[]): GroupedModels {
  const q = query.trim().toLowerCase()
  const listing = providerGroups(models)
  if (q === '') return listing
  const hit = (s: string): boolean => s.toLowerCase().includes(q)
  return {
    // the key carries its provider prefix, so a provider hit keeps every child
    groups: listing.groups.flatMap((g) => {
      const kept = g.models.filter((m) => hit(m.key) || hit(m.short))
      return kept.length === 0 ? [] : [{ provider: g.provider, models: kept }]
    }),
    loose: listing.loose.filter((m) => hit(m.key)),
  }
}
