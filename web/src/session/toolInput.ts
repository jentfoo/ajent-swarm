// Text form of a tool call's arguments, the one both the card body and the
// transcript find read, so search matches what the card paints.

// prettyInput renders arguments readably: strings verbatim, objects and arrays
// two-space indented. A value JSON cannot express (cyclic) degrades to String.
export function prettyInput(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    const text = JSON.stringify(input, null, 2)
    return text === undefined ? String(input) : text
  } catch {
    return String(input)
  }
}
