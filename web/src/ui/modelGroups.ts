import type { ModelState } from '../api/types'

// providerGroups buckets the registry under each key's prefix before its
// first slash, in first-appearance order, keys with no usable prefix come
// back loose.
export function providerGroups(models: ModelState[]): {
  groups: { provider: string; models: ModelState[] }[]
  loose: ModelState[]
} {
  const grouped = new Map<string, ModelState[]>()
  const loose: ModelState[] = []
  for (const m of models) {
    const slash = m.key.indexOf('/')
    if (slash < 1) {
      // a bare or leading-slash key has no provider label to show
      loose.push(m)
      continue
    }
    const provider = m.key.slice(0, slash)
    const rows = grouped.get(provider)
    if (rows === undefined) grouped.set(provider, [m])
    else rows.push(m)
  }
  return { groups: [...grouped].map(([provider, ms]) => ({ provider, models: ms })), loose }
}
