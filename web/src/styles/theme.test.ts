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

describe('theme touch layout rules', () => {
  // each pointer:coarse block ends at the first '} }' pair: inner rules are
  // always followed by another selector, only the block's own close doubles
  const coarseBlocks = css.match(/@media \(pointer: coarse\) \{.*?\} \}/g) ?? []

  it('stacks the composer above one action row on coarse pointers', () => {
    const block = coarseBlocks.find((b) => b.includes('.composer-box'))
    expect(block).not.toBeUndefined()
    // the prompt fills its row, the actions wrap beneath it, and the floor
    // rides the layout gate so mice keep the compact composer
    expect(block).toContain('.composer-box { flex-wrap: wrap;')
    expect(block).toContain('.composer-side { flex-direction: row;')
    expect(block).toContain('.composer-queue { width: auto;')
    expect(block).toContain('min-height: 44px')
    // the textarea keeps its shared flex: 1, so the shell glyph rides its row
    expect(block).not.toContain('.composer textarea')
  })

  it('keeps the composer floors out of the width breakpoint', () => {
    // coarse pointers gate the composer: a narrow desktop pane keeps density
    expect(css).not.toContain('@media (max-width: 48rem) { .composer-side button')
  })

  it('floors transcript disclosures on phones', () => {
    expect(css).toContain('.tool-header, .thinking summary, .injected-toggle { min-height: 44px;')
    expect(css).toContain('.jump-latest, .load-older { min-height: 44px;')
  })

  it('floors the shared menus, jobs chrome and form footers on phones', () => {
    expect(css).toContain(
      '.at-menu button, .search-list button, .search-close, .menu button { min-height: 44px;',
    )
    expect(css).toContain('.job-tabs a, .session-header .btn {')
    expect(css).toContain('.editor-actions button { min-height: 44px;')
  })
})
