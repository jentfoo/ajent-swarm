import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DiffCard, EditOpDiff, gutterWidth, intralineSpans } from './DiffCard'
import type { EditOp } from './editInput'

// Marker-prefixed content (frontmatter fences, "--foo") is legitimate body
// text, dropping it would hide deletions and mislead review.

function rows(kind: string): string[] {
  return Array.from(document.querySelectorAll(`.diff-line.${kind} .diff-text`)).map(
    (el) => el.textContent ?? '',
  )
}

function gutter(): string[] {
  return Array.from(document.querySelectorAll('.diff-line .diff-num')).map(
    (el) => el.textContent ?? '',
  )
}

function emphasized(kind: string): string[] {
  return Array.from(document.querySelectorAll(`.diff-line.${kind} .diff-em`)).map(
    (el) => el.textContent ?? '',
  )
}

const lines = (n: number, edit?: (i: number) => string | undefined): string =>
  Array.from({ length: n }, (_, i) => edit?.(i) ?? `l${i + 1}`).join('\n') + '\n'

describe('DiffCard', () => {
  it('renders frontmatter deletions instead of dropping them', () => {
    render(<DiffCard path="f.md" before={'---\ntitle: x\n---\nbody\n'} after={'body\n'} />)
    expect(rows('del')).toEqual(['---', 'title: x', '---'])
    expect(rows('ctx')).toEqual(['body'])
  })

  it('keeps marker-prefixed body rows', () => {
    render(<DiffCard path="f" before={'--foo\n=== rule\nbar\n'} after={'bar\n+++lit\n'} />)
    expect(rows('del')).toEqual(['--foo', '=== rule'])
    expect(rows('add')).toEqual(['+++lit'])
  })

  it('strips file headers but keeps hunk meta', () => {
    render(<DiffCard path="src/f.go" before={'one\ntwo\n'} after={'one\nTHREE\n'} />)
    expect(document.querySelectorAll('.diff-line.meta')).toHaveLength(1)
    const card = document.querySelector('[data-testid="diff-card"]')
    expect(card?.textContent).not.toContain('a/src/f.go')
    expect(card?.textContent).not.toContain('====')
  })

  it('renders nothing for unchanged content', () => {
    const { container } = render(<DiffCard path="f" before={'same\n'} after={'same\n'} />)
    expect(container.querySelector('[data-testid="diff-card"]')).toBeNull()
  })

  it('numbers deletions by the old file and the rest by the new', () => {
    // line 9 rewritten: context keeps its number, the del keeps old 9, the
    // add takes new 9 even though both sides show a 9
    render(
      <DiffCard
        path="f"
        before={lines(10)}
        after={lines(10, (i) => (i === 8 ? 'NINE' : undefined))}
      />,
    )
    expect(gutter()).toEqual([' 6', ' 7', ' 8', ' 9', ' 9', '10'])
    const marks = Array.from(document.querySelectorAll('.diff-line .diff-mark')).map(
      (el) => el.textContent ?? '',
    )
    expect(marks).toEqual(['  ', '  ', '  ', '- ', '+ ', '  '])
  })

  it('sizes the gutter from the whole file, not the hunk', () => {
    render(
      <DiffCard
        path="f"
        before={lines(120)}
        after={lines(120, (i) => (i === 60 ? 'X' : undefined))}
      />,
    )
    const nums = Array.from(document.querySelectorAll('.diff-line .diff-num'))
    for (const el of nums) expect(el.textContent).toHaveLength(3)
    // hunk headers carry no number, so only the 8 body rows have one
    expect(nums).toHaveLength(8)
  })

  it('drops the count for single-line hunk sides', () => {
    render(<DiffCard path="f" before={'one\n'} after={'ONE\n'} />)
    expect(document.querySelector('.diff-line.meta')?.textContent).toBe('@@ -1 +1 @@')
  })

  it('starts an empty side at zero', () => {
    render(<DiffCard path="f" before={''} after={'a\nb\n'} />)
    expect(document.querySelector('.diff-line.meta')?.textContent).toBe('@@ -0,0 +1,2 @@')
    expect(gutter()).toEqual([' 1', ' 2'])
  })

  it('formats multi-count hunk ranges', () => {
    render(
      <DiffCard
        path="f"
        before={lines(10)}
        after={lines(10, (i) => (i === 4 ? 'X' : undefined))}
      />,
    )
    expect(document.querySelector('.diff-line.meta')?.textContent).toBe('@@ -2,7 +2,7 @@')
  })

  it('drops no-newline markers', () => {
    render(<DiffCard path="f" before={'a'} after={'a\nb\n'} />)
    expect(document.body.textContent).not.toContain('No newline')
    expect(rows('del')).toEqual(['a'])
    expect(rows('add')).toEqual(['a', 'b'])
  })

  it('continues numbering across hunks', () => {
    render(
      <DiffCard
        path="f"
        before={lines(20)}
        after={lines(20, (i) => (i === 2 || i === 16 ? 'X' : undefined))}
      />,
    )
    expect(document.querySelectorAll('.diff-line.meta')).toHaveLength(2)
    expect(gutter()).toEqual([
      ' 1',
      ' 2',
      ' 3',
      ' 3',
      ' 4',
      ' 5',
      ' 6',
      '14',
      '15',
      '16',
      '17',
      '17',
      '18',
      '19',
      '20',
    ])
  })

  it('emphasizes the changed span of a paired rewrite', () => {
    render(<DiffCard path="f" before={'return foo(bar)\n'} after={'return foo(baz)\n'} />)
    expect(emphasized('del')).toEqual(['r'])
    expect(emphasized('add')).toEqual(['z'])
    expect(rows('del')).toEqual(['return foo(bar)'])
    expect(rows('add')).toEqual(['return foo(baz)'])
  })

  it('leaves a dissimilar rewrite unemphasized', () => {
    render(<DiffCard path="f" before={'aaaa\n'} after={'bbbb\n'} />)
    expect(document.querySelectorAll('.diff-em')).toHaveLength(0)
    expect(rows('del')).toEqual(['aaaa'])
    expect(rows('add')).toEqual(['bbbb'])
  })

  it('skips intraline on unequal run lengths', () => {
    // two deletions against one addition: no line-to-line pairing exists
    render(<DiffCard path="f" before={'one\ntwo\nthree\n'} after={'uno\nthree\n'} />)
    expect(document.querySelectorAll('.diff-em')).toHaveLength(0)
    expect(rows('del')).toEqual(['one', 'two'])
    expect(rows('add')).toEqual(['uno'])
  })
})

describe('gutterWidth', () => {
  it.each([
    { name: 'single line files floor at two', before: 'a\n', after: 'b\n', want: 2 },
    { name: 'ten lines stays at two', before: lines(10), after: lines(10), want: 2 },
    { name: 'hundred lines needs three', before: lines(100), after: lines(99), want: 3 },
    { name: 'grows with the larger side', before: lines(9), after: lines(1000), want: 4 },
    { name: 'counts a trailing partial line', before: 'a\nb', after: 'a\nb\n', want: 2 },
  ])('$name', ({ before, after, want }) => {
    expect(gutterWidth(before, after)).toBe(want)
  })
})

describe('intralineSpans', () => {
  it.each([
    { name: 'identical lines have no spans', before: 'same', after: 'same', want: undefined },
    {
      name: 'one char swap',
      before: 'return foo(bar)',
      after: 'return foo(baz)',
      want: { del: [[13, 14]], add: [[13, 14]] },
    },
    {
      name: 'pure insertion marks only the new side',
      before: 'ab',
      after: 'axb',
      want: { del: [], add: [[1, 2]] },
    },
    {
      name: 'nearby edits merge over the gap',
      before: 'abcdXefgYij',
      after: 'abcdAefgBij',
      want: { del: [[4, 9]], add: [[4, 9]] },
    },
    {
      name: 'edits four apart stay separate',
      before: 'abcdXefghYij',
      after: 'abcdAefghBij',
      want: {
        del: [
          [4, 5],
          [9, 10],
        ],
        add: [
          [4, 5],
          [9, 10],
        ],
      },
    },
    {
      name: 'half unchanged still passes',
      before: 'abcdefgh',
      after: 'xxxxefgh',
      want: { del: [[0, 4]], add: [[0, 4]] },
    },
    { name: 'full rewrite fails the gate', before: 'aaaa', after: 'bbbb', want: undefined },
    {
      name: 'insertion only fails the gate',
      before: '',
      after: 'abc',
      want: undefined,
    },
  ])('$name', ({ before, after, want }) => {
    expect(intralineSpans(before, after)).toEqual(want)
  })
})

const op = (overrides: Partial<EditOp> = {}): EditOp => ({
  oldText: 'one\n',
  newText: 'ONE\n',
  replaceAll: false,
  ...overrides,
})

describe('EditOpDiff', () => {
  it('renders the replacement as del and add rows', () => {
    render(<EditOpDiff op={op({ oldText: 'one\ntwo\n', newText: 'one\nTWO\n' })} />)
    expect(rows('del')).toEqual(['two'])
    expect(rows('add')).toEqual(['TWO'])
    expect(rows('ctx')).toEqual(['one'])
  })

  it('carries no hunk meta rows', () => {
    render(<EditOpDiff op={op()} />)
    expect(document.querySelectorAll('.diff-line.meta')).toHaveLength(0)
  })

  it('marks a replace-all op with a meta row', () => {
    render(<EditOpDiff op={op({ replaceAll: true })} />)
    expect(rows('meta')).toEqual(['replace every occurrence'])
  })

  it('renders a pure deletion as del rows only', () => {
    render(<EditOpDiff op={op({ newText: '' })} />)
    expect(rows('del')).toEqual(['one'])
    expect(rows('add')).toEqual([])
  })

  it('renders nothing for identical texts', () => {
    const { container } = render(<EditOpDiff op={op({ newText: 'one\n' })} />)
    expect(container.querySelector('.diff-line')).toBeNull()
  })

  it('numbers fragment rows from one on both sides', () => {
    render(<EditOpDiff op={op({ oldText: 'one\ntwo\n', newText: 'one\nTWO\n' })} />)
    expect(gutter()).toEqual([' 1', ' 2', ' 2'])
  })

  it('emphasizes a paired fragment rewrite', () => {
    render(
      <EditOpDiff op={op({ oldText: 'count = compute(x)\n', newText: 'count = compute(y)\n' })} />,
    )
    expect(emphasized('del')).toEqual(['x'])
    expect(emphasized('add')).toEqual(['y'])
  })
})
