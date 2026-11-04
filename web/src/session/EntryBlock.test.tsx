import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
    const toolId = el.getAttribute('data-tool-id')
    if (toolId !== null) return `card:${toolId}`
    if (el.classList.contains('markdown')) return `text:${el.textContent}`
    return el.className
  })
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
})
