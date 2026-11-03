import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { EntryBlock } from './EntryBlock'
import type { DerivedBlock } from '../state/derive'

// The committed assistant block renders content in wire order; the regression
// where an edit card always landed under the turn's closing message lives here.

type AssistantBlock = Extract<DerivedBlock, { kind: 'assistant' }>

function assistantBlock(parts: AssistantBlock['parts']): DerivedBlock {
  return { kind: 'assistant', id: '01A', parts, thinking: [] }
}

// childShapes names an assistant entry's direct children in DOM order.
function childShapes(entry: HTMLElement): string[] {
  return Array.from(entry.children).map((el) => {
    if (el.tagName === 'DETAILS') return 'thinking'
    if (el.tagName === 'BUTTON') return 'copy'
    const toolId = el.getAttribute('data-tool-id')
    if (toolId !== null) return `card:${toolId}`
    if (el.classList.contains('markdown')) return `text:${el.textContent}`
    return el.className
  })
}

// jsdom ships no clipboard; each file stubs it so the requirement stays
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

describe('EntryBlock assistant ordering', () => {
  it('renders parts in content order after thinking', () => {
    const block: DerivedBlock = {
      kind: 'assistant',
      id: '01A',
      thinking: ['hmm'],
      parts: [
        { kind: 'text', text: 'editing now' },
        { kind: 'call', call: { id: 'c1', name: 'edit_file', input: {} } },
        { kind: 'text', text: 'all done' },
      ],
    }

    const { container } = render(<EntryBlock block={block} />)
    const entry = container.querySelector('.entry.assistant')
    expect(entry).not.toBeNull()
    expect(childShapes(entry as HTMLElement)).toEqual([
      'block-role',
      'thinking',
      'text:editing now',
      'card:c1',
      'text:all done',
      'copy',
    ])
  })

  it('marks calls without a folded result running', () => {
    render(
      <EntryBlock
        block={assistantBlock([{ kind: 'call', call: { id: 'c1', name: 'edit_file' } }])}
      />,
    )
    expect(screen.getByText('running')).toBeInTheDocument()
  })

  it('renders a folded result without the running badge', () => {
    render(
      <EntryBlock
        block={assistantBlock([
          {
            kind: 'call',
            call: {
              id: 'c1',
              name: 'edit_file',
              result: { callId: 'c1', text: 'patched cleanly', images: [], isError: false },
            },
          },
        ])}
      />,
    )
    expect(screen.queryByText('running')).not.toBeInTheDocument()
  })

  it('shows a permit verdict chip on the call card', () => {
    render(
      <EntryBlock
        block={assistantBlock([
          { kind: 'call', call: { id: 'c1', name: 'bash', verdict: 'auto allowed' } },
        ])}
      />,
    )
    expect(screen.getByText('auto allowed')).toBeInTheDocument()
  })

  it('renders no verdict chip without one', () => {
    render(
      <EntryBlock block={assistantBlock([{ kind: 'call', call: { id: 'c1', name: 'bash' } }])} />,
    )
    expect(screen.queryByText('auto allowed')).not.toBeInTheDocument()
  })
})

describe('EntryBlock injected shape', () => {
  function injectedBlock(label: string, body: string, shellRun = false): DerivedBlock {
    return { kind: 'injected', id: '01I', replayed: true, shellRun, label, body }
  }

  it('renders label and literal mono body', () => {
    const { container } = render(
      <EntryBlock
        block={injectedBlock('User Ran: make test', '# not a heading\n--- PASS', true)}
      />,
    )
    expect(screen.getByText('User Ran: make test')).toHaveClass('injected-label')
    // tool output never reaches the markdown renderer, so --- stays literal
    const body = container.querySelector('.injected-body')
    expect(body?.textContent).toBe('# not a heading\n--- PASS')
    expect(container.querySelector('.markdown')).toBeNull()
  })

  it('accents a delivered shell run like its live card', () => {
    const { container } = render(<EntryBlock block={injectedBlock('User Ran: ls', 'file', true)} />)
    expect(container.querySelector('.entry.injected')).toHaveClass('shell-run')
  })

  it('leaves other injected context unaccented', () => {
    const { container } = render(<EntryBlock block={injectedBlock('Plan', 'step one')} />)
    expect(container.querySelector('.entry.injected')).not.toHaveClass('shell-run')
  })

  it('keeps short bodies uncollapsed', () => {
    render(<EntryBlock block={injectedBlock('User Ran: ls', 'one\ntwo')} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('paints nothing past the label for an empty body', () => {
    const { container } = render(<EntryBlock block={injectedBlock('User Ran: ls', '')} />)
    expect(container.querySelector('.injected-body')).toBeNull()
  })

  it('collapses long body behind disclosure', async () => {
    const user = userEvent.setup()
    const body = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n')
    render(<EntryBlock block={injectedBlock('User Ran: ls', body)} />)

    expect(screen.getByText('+5 more lines')).toBeInTheDocument()
    let text = document.querySelector('.injected-body')?.textContent ?? ''
    expect(text).toContain('line 9')
    expect(text).not.toContain('line 10')

    await user.click(screen.getByRole('button'))
    text = document.querySelector('.injected-body')?.textContent ?? ''
    expect(text).toContain('line 14')
    expect(screen.getByText('collapse')).toBeInTheDocument()
  })
})

describe('EntryBlock assistant copy row', () => {
  it('joins text parts with blank lines and skips calls and thinking', async () => {
    const { user, writes } = setupCopyUser(async () => {})
    render(
      <EntryBlock
        block={{
          kind: 'assistant',
          id: '01A',
          thinking: ['private musing'],
          parts: [
            { kind: 'text', text: 'first part' },
            { kind: 'call', call: { id: 'c1', name: 'bash' } },
            { kind: 'text', text: 'second part' },
          ],
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writes).toHaveBeenCalledWith('first part\n\nsecond part')
  })

  it('hides the copy row when the reply has no text parts', () => {
    stubClipboard(async () => {})
    render(
      <EntryBlock block={assistantBlock([{ kind: 'call', call: { id: 'c1', name: 'bash' } }])} />,
    )

    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
  })

  it('renders no copy row on user turns', () => {
    stubClipboard(async () => {})
    render(<EntryBlock block={{ kind: 'user', id: '01P', text: 'do it', images: [] }} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
