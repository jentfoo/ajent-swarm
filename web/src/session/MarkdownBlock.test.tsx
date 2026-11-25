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
    // the cap sits on block children and the wrap guard breaks tokens that
    // have no break point of their own
    expect(css).toContain('.markdown.prose > * { max-width: min(72ch, 100%); }')
    expect(css).toMatch(/\.markdown\.prose \{[^}]*overflow-wrap: anywhere/)
    render(<MarkdownBlock text={'A'.repeat(400)} />)
    expect(document.querySelector('.markdown.prose > p')).toHaveTextContent('A'.repeat(400))
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
