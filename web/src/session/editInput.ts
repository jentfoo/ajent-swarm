// Edit tool input parsing, kept in step with the tolerance of ajent's own
// decoder (pkg/tools/edit.go): a double-encoded argument object, edits as one
// JSON string, or a lone edit where an array is declared. Anything that decoder
// would reject parses to undefined, so the caller falls back to pretty-printing
// the raw input rather than rendering a half-read diff.

export interface EditOp {
  oldText: string
  newText: string
  replaceAll: boolean
}

export interface EditInput {
  path: string
  ops: EditOp[]
}

// parseEditInput decodes one edit call's arguments. undefined means the shape is
// not one edit.go accepts and the raw input should render instead.
export function parseEditInput(input: unknown): EditInput | undefined {
  const args = asObject(unquoteJSON(input))
  if (args === undefined || typeof args.path !== 'string') return undefined

  const edits = unquoteJSON(args.edits)
  if (edits === undefined) return undefined
  const list = Array.isArray(edits) ? edits : [edits]

  const ops: EditOp[] = []
  for (const raw of list) {
    const op = asObject(raw)
    if (op === undefined) return undefined
    if (typeof op.oldText !== 'string' || typeof op.newText !== 'string') return undefined
    ops.push({ oldText: op.oldText, newText: op.newText, replaceAll: op.replace_all === true })
  }
  return ops.length > 0 ? { path: args.path, ops } : undefined
}

// unquoteJSON unwraps a JSON string that itself holds JSON, how a model
// double-encodes an argument it should have sent as an object or array.
function unquoteJSON(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
