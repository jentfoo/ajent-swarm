import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownBlock } from './MarkdownBlock'

// Model output is untrusted input, these are the hard guarantees.

// jsdom cannot lay out text, so the prose measure's no-widening guarantee
// rides a source probe of the sheet (theme.test.ts reads it the same way).
// @ts-expect-error node builtins stay untyped in the web project on purpose
const theme = (await import('node:fs')) as {
  readFileSync(path: string, encoding: string): string
}
const css = theme.readFileSync('src/styles/theme.css', 'utf8').replace(/\s+/g, ' ')

describe('MarkdownBlock prose measure', () => {
  it('renders message text through the shared prose wrapper', () => {
    render(<MarkdownBlock text="hello" />)
    expect(screen.getByText('hello').closest('.markdown')).toHaveClass('prose')
  })

  it('keeps a long unbroken token from widening the container', () => {
    // block children stay clamped to the pane and the wrap guard breaks
    // tokens that have no break point of their own
    expect(css).toContain('.markdown.prose > * { max-width: 100%; }')
    expect(css).toMatch(/\.markdown\.prose \{[^}]*overflow-wrap: anywhere/)
    render(<MarkdownBlock text={'A'.repeat(400)} />)
    expect(document.querySelector('.markdown.prose > p')).toHaveTextContent('A'.repeat(400))
  })
})

describe('MarkdownBlock prose elements', () => {
  it('renders headings, lists and blockquotes as elements', () => {
    render(<MarkdownBlock text={'# Title\n\n- one\n- two\n\n> quoted note'} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Title')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText(/quoted note/).closest('blockquote')).not.toBeNull()
  })

  it('opens links in a new tab with an sr-only hint', () => {
    render(<MarkdownBlock text={'[docs](https://example.com)'} />)
    const link = screen.getByText('docs').closest('a')
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText(/opens in new tab/)).toHaveClass('sr-only')
  })

  it('renders a stripped javascript link without an anchor', () => {
    render(<MarkdownBlock text={'[click](javascript:alert(1))'} />)
    // the sanitizer drops the href, the renderer then declines to wrap it
    expect(document.querySelector('a')).toBeNull()
    expect(screen.getByText('click')).toBeInTheDocument()
  })

  it('wraps tables in a focusable scroll port', () => {
    render(<MarkdownBlock text={'| a | b |\n|---|---|\n| 1 | 2 |'} />)
    const wrap = document.querySelector('.table-scroll')
    expect(wrap).not.toBeNull()
    expect(wrap).toHaveAttribute('tabindex', '0')
    expect(wrap).toHaveAttribute('aria-label', 'Scrollable table')
    expect(wrap?.querySelector('table')).not.toBeNull()
  })

  it('keeps the inline code chip away from fenced code', () => {
    // jsdom cannot lay out text, so the rule's scope carries the guarantee
    expect(css).toMatch(/\.markdown :not\(pre\) > code \{[^}]*background: var\(--surface-2\)/)
  })
})

describe('MarkdownBlock table columns', () => {
  it('floors each column at its longest cell width', () => {
    render(<MarkdownBlock text={'| id | name |\n|---|---|\n| 1 | Alexander |'} />)
    // jsdom cannot lay out ch units, so the floor reads off the inline style
    const cells = Array.from(document.querySelectorAll<HTMLElement>('th, td'))
    expect(cells.map((cell) => cell.style.minWidth)).toEqual(['2ch', '9ch', '2ch', '9ch'])
  })

  it('caps the floor so one long column cannot dominate', () => {
    render(<MarkdownBlock text={'| a | b |\n|---|---|\n| 1 | a very long cell body indeed |'} />)
    const cells = Array.from(document.querySelectorAll<HTMLElement>('td'))
    expect(cells.map((cell) => cell.style.minWidth)).toEqual(['1ch', '16ch'])
  })

  it('merges the floor beside alignment styles', () => {
    render(<MarkdownBlock text={'| l | r |\n|:--|--:|\n| 1 | 2 |'} />)
    const cells = Array.from(document.querySelectorAll<HTMLElement>('th'))
    expect(cells[0]).toHaveStyle({ textAlign: 'left' })
    expect(cells[1]).toHaveStyle({ textAlign: 'right' })
    expect(cells.every((cell) => cell.style.minWidth !== '')).toBe(true)
  })
})

describe('MarkdownBlock sanitize', () => {
  it('never renders raw HTML from model output', () => {
    render(
      <MarkdownBlock
        text={
          'hello\n<script>window.__pwned = true</script>\n<img src=x onerror="window.__pwned = true">\n[click](javascript:alert(1))'
        }
      />,
    )
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    const link = document.querySelector('a')
    if (link) expect(link.getAttribute('href')).not.toMatch(/^javascript:/)
  })

  it('renders GFM tables and task lists through the sanitizer', () => {
    render(<MarkdownBlock text={'| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done item'} />)
    expect(document.querySelector('table')).not.toBeNull()
    // the checkbox input is dropped by the default schema, the list stays
    expect(screen.getByText(/done item/)).toBeInTheDocument()
  })

  it('keeps fenced code as text before shiki highlights', () => {
    render(<MarkdownBlock text={'```js\nconst a = "<b>not html</b>"\n```\n'} />)
    const fence = document.querySelector('.fence')
    expect(fence).not.toBeNull()
    // the code body is plain text here, never parsed as markup
    expect(fence?.textContent).toContain('<b>not html</b>')
  })

  it('renders inline code without interpreting entities', () => {
    render(<MarkdownBlock text={'use `<script>` tags carefully'} />)
    expect(screen.getByText('<script>', { exact: false })).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })
})
