// The composer's @-path completion state machine: one pure tokenizer plus the
// keyboard rules shared by tests and the component.
export interface AtToken {
  start: number // index of the '@' opening the token
  query: string // text between '@' and the caret, whitespace-free
}

// atTokenBefore finds the @-path token the caret sits in, or null. A token
// opens after line start or whitespace and never spans whitespace itself, so
// prose mentions like "email me@" stay untouched.
export function atTokenBefore(text: string, caret: number): AtToken | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const i = upto.lastIndexOf('@')
  if (i < 0) return null
  if (i > 0 && !/\s/.test(upto[i - 1])) return null // mid-word @: not a path
  const query = upto.slice(i + 1)
  if (/\s/.test(query)) return null
  return { start: i, query }
}
