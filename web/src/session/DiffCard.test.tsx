import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DiffCard } from './DiffCard'

// Marker-prefixed content (frontmatter fences, "--foo") is legitimate body
// text; dropping it would hide deletions and mislead review.

function diffLines(kind: string): string[] {
  return Array.from(document.querySelectorAll(`.diff-line.${kind}`)).map(
    (el) => el.textContent ?? '',
  )
}

describe('DiffCard', () => {
  it('renders frontmatter deletions instead of dropping them', () => {
    render(<DiffCard path="f.md" before={'---\ntitle: x\n---\nbody\n'} after={'body\n'} />)
    expect(diffLines('del')).toEqual(['---', 'title: x', '---'])
    expect(screen.getByText('body')).toHaveClass('ctx')
  })

  it('keeps marker-prefixed body rows', () => {
    render(<DiffCard path="f" before={'--foo\n=== rule\nbar\n'} after={'bar\n+++lit\n'} />)
    expect(diffLines('del')).toEqual(['--foo', '=== rule'])
    expect(diffLines('add')).toEqual(['+++lit'])
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
})
