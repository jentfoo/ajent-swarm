// The one matching rule the operational list filters share: a case-insensitive
// substring hit across each row's candidate facts, a whitespace-only query
// reading as no filter at all.

// normalizeQuery folds a raw filter box value into its matching form: trimmed
// and lowercased, empty when the box holds whitespace only.
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

// matchesQuery reports whether any candidate text contains the normalized
// query. An empty query matches everything; undefined candidates never do.
export function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  if (query === '') return true
  return fields.some((f) => f !== undefined && f.toLowerCase().includes(query))
}
