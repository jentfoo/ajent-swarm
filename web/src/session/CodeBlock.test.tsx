import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodeBlock } from './CodeBlock'

// shiki is mocked so the highlighted branch lands deterministically without
// loading grammar bundles; tokens mirror the shape codeToTokens returns
const { codeToTokens } = vi.hoisted(() => ({
  codeToTokens: vi.fn(async () => ({
    tokens: [[{ content: 'fmt', color: '#FF7B72' }, { content: '.Println("hi")' }]],
    fg: '#e6edf3',
    bg: '#0d1117',
    themeName: 'github-dark',
  })),
}))
vi.mock('shiki', () => ({ codeToTokens }))

// jsdom ships no clipboard, each file stubs it so the requirement stays
// visible at the call sites it covers
function stubClipboard(writeText: (text: string) => Promise<void>) {
  const fn = vi.fn(writeText)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: fn } })
  return fn
}

// setup() installs user-event's own clipboard stub, so the explicit one
// above must land after it to stay what the component writes through
function setupCopyUser(writeText: (text: string) => Promise<void>) {
  const user = userEvent.setup()
  const writes = stubClipboard(writeText)
  return { user, writes }
}

beforeEach(() => codeToTokens.mockClear())
afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard
  vi.useRealTimers()
})

describe('CodeBlock copy button', () => {
  it('copies the code prop verbatim from the plain fence', async () => {
    const { user, writes } = setupCopyUser(async () => {})
    render(<CodeBlock code={'const a = "<b>not html</b>"'} />)

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writes).toHaveBeenCalledWith('const a = "<b>not html</b>"')
  })

  it('copies the same payload once highlighted', async () => {
    const { user, writes } = setupCopyUser(async () => {})
    render(<CodeBlock code={'fmt.Println("hi")'} lang={'go'} />)
    await act(async () => {}) // let the mocked highlighter land

    expect(document.querySelector('.fence code span')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writes).toHaveBeenCalledWith('fmt.Println("hi")')
  })

  it('pins the button outside the scrolling fence', async () => {
    stubClipboard(async () => {})
    render(<CodeBlock code={'x'} lang={'js'} />)
    await act(async () => {}) // the mocked highlighter resolves outside act otherwise

    // the pre scrolls horizontally, so the overlay must not ride inside it
    expect(document.querySelector('pre.fence')?.querySelector('button')).toBeNull()
    expect(document.querySelector('.fence-wrap > .copy-btn.fence-copy')).not.toBeNull()
  })

  it('flips the copied icon then resolves back', async () => {
    vi.useFakeTimers()
    stubClipboard(async () => {})
    render(<CodeBlock code={'x'} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await act(async () => {}) // the write promise resolves on a microtask
    expect(screen.getByText('Copied').closest('[data-on]')).toHaveAttribute('data-on', 'true')

    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText('Copy').closest('[data-on]')).toHaveAttribute('data-on', 'true')
  })

  it('shows copy failed on a rejected write', async () => {
    const { user } = setupCopyUser(() => Promise.reject(new Error('denied')))
    render(<CodeBlock code={'x'} />)

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(screen.getByText('Copy failed').closest('[data-on]')).toHaveAttribute('data-on', 'true')
  })

  it('renders hostile token content as escaped text, never markup', async () => {
    stubClipboard(async () => {})
    const hostile = '<img src=x onerror="window.__pwned = true">'
    codeToTokens.mockResolvedValueOnce({
      tokens: [[{ content: hostile, color: '#FF7B72' }]],
      fg: '#e6edf3',
      bg: '#0d1117',
      themeName: 'github-dark',
    })
    render(<CodeBlock code={hostile} lang={'js'} />)
    await act(async () => {}) // let the mocked highlighter land

    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.fence')?.textContent).toContain(hostile)
  })
})
