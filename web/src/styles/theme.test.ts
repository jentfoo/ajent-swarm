import { describe, expect, it } from 'vitest'

// The visible keyboard-focus contract lives in these style rules: one shared
// :focus-visible ring over --focus-ring, a color that stays off both fill
// tokens so it survives on primary buttons and armed danger, covering bg,
// surface and surface-2 in both themes without any per-control restatement,
// and text fields that keep their border tint while gaining the same ring.
// Node's fs reads the sheet under every vitest environment; the web tsconfig
// types only the DOM, so this single probe steps outside it deliberately.
// @ts-expect-error node builtins stay untyped in the web project on purpose
const theme = (await import('node:fs')) as {
  readFileSync(path: string, encoding: string): string
}
const css = theme.readFileSync('src/styles/theme.css', 'utf8').replace(/\s+/g, ' ')
// comments stripped before token parsing so prose never parses as a value
const bareCss = css.replace(/\/\*.*?\*\//g, ' ')

// one theme block's custom properties as name -> value pairs
function themeTokens(selector: RegExp): Map<string, string> {
  const found = new Map<string, string>()
  for (const m of bareCss.match(selector)![1].matchAll(/--([\w-]+): ([^;]+);/g)) {
    found.set(m[1], m[2].trim())
  }
  return found
}

// var() references resolved, so the contrast math always sees a concrete color
function resolved(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name)
  if (value === undefined) throw new Error(`--${name} has no declaration`)
  const alias = value.match(/^var\(--([\w-]+)\)$/)
  return alias ? resolved(tokens, alias[1]) : value
}

// WCAG 2.x relative luminance and contrast ratio for sRGB hex colors
function luminance(hex: string): number {
  const lin = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const darkTokens = themeTokens(/:root, \[data-theme='dark'\] \{([^}]*)\}/)
const lightTokens = themeTokens(/\[data-theme='light'\] \{([^}]*)\}/)

describe('theme focus rules', () => {
  it('declares one shared focus_visible ring', () => {
    expect(css).toContain(
      ':focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px;',
    )
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

describe('theme type scale', () => {
  it('declares every step in rem so browser settings scale the sheet', () => {
    for (const step of ['xs', 'small', 'body', 'prose', 'title', 'display']) {
      expect(css).toMatch(new RegExp(`--fs-${step}: [\\d.]+rem;`))
    }
  })

  it('caps prose at a book measure while code keeps the pane', () => {
    expect(css).toContain('.markdown.prose > * { max-width: min(72ch, 100%); }')
    // fences and table scroll ports re-join the full pane width past the cap
    expect(css).toMatch(
      /\.markdown\.prose > \.fence-wrap, \.markdown\.prose > \.table-scroll \{[^}]*max-width: none;/,
    )
  })
})

describe('theme markdown prose', () => {
  it('breaks unbroken tokens inside the message column', () => {
    // a long URL or token must never widen a tile pane or the transcript
    expect(css).toMatch(/\.markdown\.prose \{[^}]*overflow-wrap: anywhere/)
  })

  it('gives wide tables their own scroll port', () => {
    // the } boundary skips the measure's > .table-scroll exclusion above, and
    // stripped comments leave space runs, so the gap stays flexible
    const rule = bareCss.match(/(?:^|\})\s*\.table-scroll \{[^}]*\}/)![0]
    expect(rule).toContain('overflow-x: auto;')
    expect(rule).toContain('max-width: 100%;')
  })

  it('chips inline code without touching fence bodies', () => {
    // :not(pre) is the scope, CodeBlock renders its own pre > code
    const rule = bareCss.match(/\.markdown :not\(pre\) > code \{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('background: var(--surface-2);')
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
    expect(css).toContain(
      '.tool-header, .thinking summary, .injected-toggle, .diff-toggle { min-height: 44px;',
    )
    expect(css).toContain('.tool-copy { min-width: 44px; min-height: 44px;')
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

describe('theme menu body', () => {
  it('stacks the role element inside a popover layer', () => {
    // MenuPopover's layer is the caller's className box; the role element under
    // a header must lay its items out the same column the layer used to
    const rule = bareCss.match(/\.menu-body \{[^}]*\}/)![0]
    expect(rule).toContain('display: flex;')
    expect(rule).toContain('flex-direction: column;')
  })
})

describe('theme dialog dock bounds', () => {
  const touchDock = css.match(/\.dialog-dock\.touch \{[^}]*\}/)![0]

  it('caps the touch dock against flex space, not a fixed pixel', () => {
    // min-height 0 lets flex shrink the dock before the transcript, the
    // viewport ceiling keeps a free dock from filling the screen
    expect(touchDock).toContain('min-height: 0;')
    expect(touchDock).toContain('max-height: min(60vh, 100%);')
  })

  it('scrolls only past the cap so short answers keep one container', () => {
    expect(touchDock).toContain('overflow-y: auto;')
  })

  it('leaves the desktop dock uncapped', () => {
    const base = css.match(/\.dialog-dock \{[^}]*\}/)![0]
    expect(base).not.toContain('max-height')
    expect(base).not.toContain('overflow')
  })
})

describe('theme mobile bottom fit', () => {
  // the phone breakpoint block carrying the mobile session's bottom chrome,
  // sliced from its transcript rule through the status bar rules
  const phoneBlock = bareCss.match(
    /@media \(max-width: 48rem\) \{ \.mobile-session \.transcript-wrap \{.*?\.queue-chip \{/,
  )![0]

  it('wraps the status bar under the breakpoint while desktop stays one line', () => {
    const bar = phoneBlock.match(/\.mobile-session \.status-bar \{[^}]*\}/)![0]
    expect(bar).toContain('flex-wrap: wrap;')
    // a wrapped line keeps clear of the one above it
    expect(bar).toContain('row-gap:')

    const base = bareCss.match(/(?:^|\})\s*\.status-bar \{[^}]*\}/)![0]
    expect(base).not.toContain('flex-wrap')
    // the long/short segment swap keeps its container
    expect(base).toContain('container-type: inline-size;')
  })

  it('lets the activity row grow past its desktop ceiling', () => {
    const activity = phoneBlock.match(/\.mobile-session \.bar-activity \{[^}]*\}/)![0]
    // the ceiling leaves room for the spinner beside it, so a long row
    // ellipsizes on the first line instead of wrapping under the glyph
    expect(activity).toContain('max-width: calc(100% - 3rem);')

    const base = bareCss.match(/(?:^|\})\s*\.bar-activity \{[^}]*\}/)![0]
    expect(base).toContain('max-width: 40%;')
    expect(base).toContain('text-overflow: ellipsis;')
    expect(base).toContain('white-space: nowrap;')
  })

  it('keeps the segment chips unshrunk so the wrap carries the pressure', () => {
    expect(bareCss).toContain('.strip-segment { flex-shrink: 0; }')
  })

  it('scrolls a capped draft inside the composer field', () => {
    // the overflow class rides the cap only, so a fitting field never shows
    // a scrollbar
    expect(bareCss).toContain('.composer textarea.capped { overflow-y: auto; }')
    const base = bareCss.match(/\.composer textarea \{[^}]*\}/)![0]
    expect(base).toContain('resize: none;')
    expect(base).not.toContain('overflow')
  })

  it('frames the dialog placeholder like the composer it stands in for', () => {
    const placeholder = bareCss.match(/\.composer-placeholder \{[^}]*\}/)![0]
    expect(placeholder).toContain('border-top: 1px solid var(--border);')
    expect(placeholder).toContain('margin: 0;')
  })
})

describe('theme motion tokens', () => {
  it('declares fast and base steps plus one shared ease-out curve', () => {
    expect(css).toMatch(/--dur-fast: \d+ms;/)
    expect(css).toMatch(/--dur-base: \d+ms;/)
    expect(css).toContain('--ease-out: cubic-bezier(')
  })

  it('enters every overlay layer through the shared tokens', () => {
    for (const name of ['menu-fade', 'fade-in', 'modal-card-in', 'sheet-in', 'pushed-screen-in']) {
      expect(css).toContain(`@keyframes ${name}`)
    }
    // each entrance resolves its duration through a token, never a literal,
    // so reduced-motion has one place to act
    const entrances = [
      /\.pop-fade \{[^}]*animation: menu-fade var\(--dur-base\) var\(--ease-out\)/,
      /\.modal-backdrop \{[^}]*animation: fade-in var\(--dur-base\) var\(--ease-out\)/,
      /\.modal \{[^}]*animation: modal-card-in var\(--dur-base\) var\(--ease-out\)/,
      /\.bottom-sheet \{[^}]*animation: sheet-in var\(--dur-base\) var\(--ease-out\)/,
      /\.pushed-screen \{[^}]*animation: pushed-screen-in var\(--dur-base\) var\(--ease-out\)/,
    ]
    for (const rule of entrances) {
      expect(css).toMatch(rule)
    }
  })

  it('keeps the menu entrance opacity-only', () => {
    // transforms move the box mount measurement reads, so placement would
    // measure a mid-flight layer
    const fade = css.match(/@keyframes menu-fade \{.*?\} \}/)![0]
    expect(fade).toContain('opacity: 0;')
    expect(fade).not.toContain('transform:')
  })

  it('stands the sheet entrance down beside its transition while dragging', () => {
    const rule = css.match(/\.bottom-sheet\.dragging \{[^}]*\}/)![0]
    expect(rule).toContain('transition: none;')
    expect(rule).toContain('animation: none;')
  })

  it('zeroes the durations under prefers-reduced-motion', () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{.*?\} \}/)![0]
    expect(block).toContain('--dur-fast: 0ms;')
    expect(block).toContain('--dur-base: 0ms;')
  })
})

describe('theme contrast tokens', () => {
  const fills = ['accent-fill', 'danger-fill']
  const texts = ['accent-fg', 'warn-fg']

  it('declares fill, text and ring tokens in both themes', () => {
    for (const name of [...fills, ...texts, 'focus-ring']) {
      expect(resolved(darkTokens, name)).toMatch(/^#[0-9a-f]{6}$/)
      expect(resolved(lightTokens, name)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('holds AA between each filled control and its white label', () => {
    for (const tokens of [darkTokens, lightTokens]) {
      for (const fill of fills) {
        expect(contrast('#ffffff', resolved(tokens, fill))).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('reads accent and warn text on every surface', () => {
    for (const tokens of [darkTokens, lightTokens]) {
      for (const fg of texts) {
        for (const back of ['bg', 'surface', 'surface-2']) {
          expect(contrast(resolved(tokens, fg), resolved(tokens, back))).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps the focus ring clear of both fills', () => {
    for (const tokens of [darkTokens, lightTokens]) {
      const ring = resolved(tokens, 'focus-ring')
      expect(contrast(ring, resolved(tokens, 'accent-fill'))).toBeGreaterThanOrEqual(3)
      expect(contrast(ring, resolved(tokens, 'danger-fill'))).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('theme token routing', () => {
  it('fills primary, armed danger, badge and segment from the fill tokens', () => {
    expect(bareCss).toContain(
      'button.primary, .btn.primary { background: var(--accent-fill); border-color: var(--accent-fill);',
    )
    expect(bareCss).toContain('.segmented button.active { background: var(--accent-fill);')
    expect(bareCss).toContain('button.danger.armed { background: var(--danger-fill);')
    expect(bareCss).toContain(
      '.attend-badge { background: var(--danger-fill); border-color: var(--danger-fill);',
    )
  })

  it('reads text links and badges through the fg tokens', () => {
    expect(bareCss).toContain('a { color: var(--accent-fg);')
    expect(bareCss).toContain('.badge.accent { color: var(--accent-fg);')
    expect(bareCss).toContain('.badge.warn { color: var(--warn-fg);')
    expect(bareCss).toContain('.warn-text { color: var(--warn-fg);')
  })
})

describe('theme scroll ports', () => {
  // one grouped rule carries the thin bar, so a classic scrollbar appearing
  // inside a long menu or list never shifts content
  const thinRule =
    /[^{}]+\{ scrollbar-width: thin; scrollbar-color: var\(--border\) transparent; \}/
  const scrollPorts = [
    '.transcript-scroll',
    '.menu',
    '.tile-menu',
    '.rewind-list',
    '.table-scroll', // a wide table's own port gets the same thin bar
    '.transcript-preview',
    '.bottom-sheet', // scrollbar props inherit onto the sheet's scrolling body
  ]

  it('thins every scroll port to the border color', () => {
    const rule = bareCss.match(thinRule)
    expect(rule).not.toBeNull()
    for (const port of scrollPorts) {
      expect(rule![0]).toContain(port)
    }
  })

  it('reserves a gutter only on the tall list panes', () => {
    const rule = bareCss.match(/[^{}]+\{ scrollbar-gutter: stable; \}/)
    expect(rule).not.toBeNull()
    for (const port of ['.transcript-scroll', '.rewind-list', '.transcript-preview']) {
      expect(rule![0]).toContain(port)
    }
    // short menus would show an empty strip for a bar that never scrolls
    expect(rule![0]).not.toContain('.menu')
  })

  it('keeps one webkit fallback with the same colors', () => {
    const fallback = bareCss.match(/[^{}]+::-webkit-scrollbar\S* \{[^}]*\}/g) ?? []
    expect(fallback).toHaveLength(3)
    // every standard scroll port gets the fallback too
    const joined = fallback.join(' ')
    for (const port of scrollPorts.slice(0, -1)) {
      expect(joined).toContain(port)
    }
    const thumb = fallback.find((rule) => rule.includes('-thumb')) ?? ''
    expect(thumb).toContain('background: var(--border)')
    const track = fallback.find((rule) => rule.includes('-track')) ?? ''
    expect(track).toContain('background: transparent')
  })
})

describe('theme native controls', () => {
  it('tints native checkboxes and radios with the accent', () => {
    expect(bareCss).toMatch(
      /input\[type='checkbox'\], input\[type='radio'\] \{ accent-color: var\(--accent\); \}/,
    )
  })

  it('keeps placeholders readable in both themes', () => {
    const rule = bareCss.match(/input::placeholder, textarea::placeholder \{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('color: var(--muted);')
    // Firefox dims placeholders by default
    expect(rule![0]).toContain('opacity: 1;')
  })
})

describe('theme settings rows', () => {
  const rowRule = bareCss.match(/\.setting-row \{[^}]*\}/)![0]

  it('lays each setting row out on a label-control-action grid', () => {
    // the label track holds 9-14rem, the control shrinks to zero and the
    // action hugs its content, so Apply buttons line up down the menu
    expect(rowRule).toContain('display: grid;')
    expect(rowRule).toContain(
      'grid-template-columns: minmax(9rem, 14rem) minmax(0, 1fr) max-content;',
    )
  })

  it('fills the text field across the control track instead of flexing', () => {
    const input = bareCss.match(/\.setting-row\.text input \{[^}]*\}/)![0]
    expect(input).toContain('width: 100%;')
    expect(input).toContain('min-width: 0;')
    // the old flex rule would fight the grid track
    expect(bareCss).not.toContain('.setting-row.text input { flex: 1')
  })

  it('spans an uneditable row value across control and action', () => {
    const disabled = bareCss.match(/\.setting-row\.disabled \.setting-value \{[^}]*\}/)![0]
    expect(disabled).toContain('grid-column: span 2;')
  })

  it('wraps rows onto label-over-controls lines under the phone breakpoint', () => {
    // two tracks replace the three: the label takes line one whole, control
    // and action share line two at the 320px floor
    expect(bareCss).toMatch(
      /@media \(max-width: 48rem\) \{\s+\.setting-row \{ grid-template-columns: minmax\(0, 1fr\) max-content; \} \.setting-label \{ grid-column: 1 \/ -1; \}/,
    )
  })
})

describe('theme job editor split', () => {
  it('bounds the card beside its scroll body and footer at every breakpoint', () => {
    const modal = bareCss.match(/\.modal\.job-editor \{[^}]*\}/)![0]
    expect(modal).toContain('display: flex;')
    expect(modal).toContain('flex-direction: column;')
    expect(modal).toContain('position: relative;')
    expect(modal).toContain('overflow: hidden;')

    const form = bareCss.match(/\.modal\.job-editor form \{[^}]*\}/)![0]
    expect(form).toContain('display: flex;')
    expect(form).toContain('min-height: 0;')

    const scroll = bareCss.match(/\.modal\.job-editor \.editor-scroll \{[^}]*\}/)![0]
    expect(scroll).toContain('flex: 1;')
    expect(scroll).toContain('min-height: 0;')
    expect(scroll).toContain('overflow-y: auto;')

    const actions = bareCss.match(/\.modal\.job-editor \.editor-actions \{[^}]*\}/)![0]
    expect(actions).toContain('flex-shrink: 0;')
  })

  it('keeps the mobile full-screen and safe-area overrides', () => {
    expect(bareCss).toContain(
      '.modal.job-editor { width: 100vw; height: 100%; max-height: 100%; border-radius: 0; }',
    )
    expect(bareCss).toContain('.modal.job-editor form { height: 100%; }')
    expect(bareCss).toContain(
      '.modal.job-editor .editor-actions { padding-bottom: env(safe-area-inset-bottom, 0px); }',
    )
  })

  it('pins the corner close inside the flex-column cards', () => {
    // floats die on flex items, so rewind and job cards position: relative
    // anchor an absolute ✕ while their inner bodies own scrolling
    const pinned = bareCss.match(
      /\.modal\.rewind-modal > \.modal-close, \.modal\.job-editor > \.modal-close \{[^}]*\}/,
    )![0]
    expect(pinned).toContain('position: absolute;')
  })
})

describe('theme tabular numerals', () => {
  it('aligns table digits through the shared class', () => {
    expect(bareCss).toContain('.tnum { font-variant-numeric: tabular-nums; }')
  })

  it('keeps body text on default numerals', () => {
    // only the meter count and .tnum opt in, never a global face
    const carriers = bareCss.match(/[^{}]+\{[^}]*font-variant-numeric: tabular-nums;[^}]*\}/g) ?? []
    expect(carriers).toHaveLength(2)
    expect(carriers.join(' ')).toContain('.meter-count')
  })
})

describe('theme table row pointers', () => {
  it('keeps the pointer on the clickable run row only', () => {
    expect(bareCss).toMatch(/(?:^|\})\s*\.run-row \{ cursor: pointer; \}/)
    // a jobs row has no click handler, so its cursor must not promise one
    expect(bareCss).not.toContain('.jobs-table tbody tr')
  })
})
