import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownBlock } from './MarkdownBlock'

// Model output is untrusted input; these are the hard guarantees.

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
    // the checkbox input is dropped by the default schema; the list stays
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
