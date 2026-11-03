import type { ContextData, UsageState } from '../api/types'

// The status bar's numeric facts, kept out of the component so the meter math
// stays table-testable. The meter fills against the compaction budget when one
// exists, so a full bar means compaction fires now, while the count shows used
// against the real window, `~`-prefixed while upstream marks it estimated
// (ajent docs/tui-design.md, "Status line"). The tooltips carry the fuller
// breakdowns.

// escalation thresholds against the fill budget, in percent
const warnPct = 70
const dangerPct = 90

// contextBudget is the denominator the meter fills against: the compaction
// threshold when set, else the window.
export function contextBudget(ctx: ContextData): number {
  return ctx.compact > 0 ? ctx.compact : ctx.window
}

// contextPct is the fill percent against the budget, clamped to 0..100;
// 0 when the window is unknown.
export function contextPct(ctx: ContextData): number {
  const budget = contextBudget(ctx)
  if (budget <= 0) return 0
  return Math.min(Math.max((ctx.used / budget) * 100, 0), 100)
}

// contextLevel names the meter's escalation class: '' below warn, then warn
// and danger, measured against the same budget as the fill.
export function contextLevel(ctx: ContextData): string {
  const pct = contextPct(ctx)
  if (pct >= dangerPct) return 'danger'
  if (pct >= warnPct) return 'warn'
  return ''
}

// contextCount renders the bar's compact count, used over the real window,
// `~`-prefixed while the figure is an estimate.
export function contextCount(ctx: ContextData): string {
  return `${ctx.estimated ? '~' : ''}${formatTokens(ctx.used)}/${formatTokens(ctx.window)}`
}

// contextTitle is the meter's tooltip: the exact figures plus the compaction
// line when a budget exists.
export function contextTitle(ctx: ContextData): string {
  const est = ctx.estimated ? '~' : ''
  let title = `context ${est}${ctx.used.toLocaleString()}/${ctx.window.toLocaleString()} tokens`
  if (ctx.compact > 0) title += `, compacts at ${ctx.compact.toLocaleString()}`
  return title
}

// usageTitle is the turns chip's tooltip: in/out totals, the cache and
// reasoning splits when nonzero, and child spend when sub-agents spent.
export function usageTitle(usage: UsageState): string {
  const { input, output, cacheRead, cacheWrite, reasoning } = usage.total
  const lines = [`${input.toLocaleString()} in / ${output.toLocaleString()} out`]
  if (cacheRead > 0 || cacheWrite > 0) {
    lines.push(`cache ${cacheRead.toLocaleString()} read / ${cacheWrite.toLocaleString()} write`)
  }
  if (reasoning > 0) lines.push(`${reasoning.toLocaleString()} reasoning`)
  if (usage.child.input > 0 || usage.child.output > 0) {
    lines.push(
      `sub-agents ${usage.child.input.toLocaleString()} in / ${usage.child.output.toLocaleString()} out`,
    )
  }
  return lines.join('\n')
}

// formatTokens abbreviates a token count as 950, 12.5k or 1.2M, matching
// ajent's strutil.FormatTokens so both surfaces read the same.
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return trimZero((n / 1_000_000).toFixed(1)) + 'M'
  if (n >= 1_000) return trimZero((n / 1_000).toFixed(1)) + 'k'
  return String(n)
}

// trimZero drops a trailing ".0" so 200_000 reads 200k, not 200.0k.
function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}
