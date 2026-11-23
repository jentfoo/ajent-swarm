import { describe, expect, it } from 'vitest'

// The visible keyboard-focus contract lives in these style rules: one shared
// :focus-visible ring over the theme accent, covering bg, surface and
// surface-2 in both themes without any per-control restatement, and text
// fields that keep their border tint while gaining the same ring. Node's fs
// reads the sheet under every vitest environment; the web tsconfig types only
// the DOM, so this single probe steps outside it deliberately.
// @ts-expect-error node builtins stay untyped in the web project on purpose
const theme = (await import('node:fs')) as {
  readFileSync(path: string, encoding: string): string
}
const css = theme.readFileSync('src/styles/theme.css', 'utf8').replace(/\s+/g, ' ')

describe('theme focus rules', () => {
  it('declares one shared focus_visible ring', () => {
    expect(css).toContain(':focus-visible { outline: 2px solid var(--accent);')
  })

  it('tints field borders on focus without suppressing the ring', () => {
    const inputs = css.match(/input:focus, select:focus, textarea:focus \{[^}]*\}/)
    expect(inputs).not.toBeNull()
    expect(inputs![0]).toContain('border-color: var(--accent)')
    // no outright outline suppression anywhere: the shared rule must reach
    // every control, text fields included
    expect(css).not.toContain('outline: none')
  })
})
