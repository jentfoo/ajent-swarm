// LineKind mirrors ajent's classification of a submitted line (ParseLine in
// ajent/pkg/command): prompt, /command dispatch, a !shell run staged onto
// context, or a !! run excluded from context entirely. Ajent's dispatch stays
// authoritative; this only drives the composer's shell-mode affordances.
export type LineKind = 'prompt' | 'command' | 'shell' | 'shell-excluded'

// classifyLine sorts one line the way ajent will: `!!x` runs excluded from
// context, `!x` stages its output onto the next prompt, `/x` dispatches a
// command, and `//x` plus a multi-line paste opening with `/name args` stay
// literal prompts. Callers pass the submitted line, so a leading space (the
// literal escape) lands here as an ordinary prompt.
export function classifyLine(line: string): LineKind {
  if (line.startsWith('//')) return 'prompt'
  if (line.startsWith('/') && line.includes('\n')) return 'prompt'
  if (line.startsWith('!!')) return 'shell-excluded'
  if (line.startsWith('!')) return 'shell'
  if (line.startsWith('/')) return 'command'
  return 'prompt'
}
