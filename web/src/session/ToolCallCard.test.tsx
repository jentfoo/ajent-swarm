import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ToolCallCard } from './ToolCallCard'

// Input rendering: edit calls render one diff per op instead of escaped JSON,
// every other shape pretty-prints, and long committed outputs collapse behind
// the header's line count. Open/close behavior is covered from the outside by
// EntryBlock and LiveStreamBlock tests; this file pins the body itself.

function rows(kind: string): string[] {
  return Array.from(document.querySelectorAll(`.diff-line.${kind}`)).map(
    (el) => el.textContent ?? '',
  )
}

function longBody(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')
}

describe('ToolCallCard inputs', () => {
  it('renders edit input as per-op diffs', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'edit',
          input: { path: 'a.go', edits: [{ oldText: 'one\n', newText: 'ONE\n' }] },
        }}
      />,
    )
    expect(screen.getByText('a.go')).toHaveClass('diff-path')
    expect(rows('del')).toEqual(['one'])
    expect(rows('add')).toEqual(['ONE'])
    // the escaped JSON never renders for a parseable edit
    expect(document.querySelector('pre.muted')).toBeNull()
  })

  it('counts multi-op edits on the path chip', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'edit',
          input: {
            path: 'a.go',
            edits: [
              { oldText: 'one\n', newText: 'ONE\n' },
              { oldText: 'two\n', newText: 'TWO\n' },
            ],
          },
        }}
      />,
    )
    expect(screen.getByText('a.go · 2 edits')).toBeInTheDocument()
    expect(document.querySelectorAll('.diff-pre')).toHaveLength(2)
  })

  it('unwraps string-encoded edits', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'edit',
          input: { path: 'a.go', edits: JSON.stringify([{ oldText: 'x\n', newText: 'y\n' }]) },
        }}
      />,
    )
    expect(rows('add')).toEqual(['y'])
  })

  it('pretty-prints unparseable edit input', () => {
    render(
      <ToolCallCard
        call={{ id: 'c1', name: 'edit', input: { path: 'a.go', edits: [{ oldText: 4 }] } }}
      />,
    )
    const pre = document.querySelector('pre.muted')
    expect(pre?.textContent).toContain('"path": "a.go"')
    expect(pre?.textContent).toContain('"oldText": 4')
  })

  it('pretty-prints object inputs with two-space indent', () => {
    render(<ToolCallCard call={{ id: 'c1', name: 'bash', input: { cmd: 'go build ./...' } }} />)
    expect(document.querySelector('pre.muted')?.textContent).toBe('{\n  "cmd": "go build ./..."\n}')
  })

  it('keeps string inputs verbatim', () => {
    render(<ToolCallCard call={{ id: 'c1', name: 'bash', input: 'go test ./...' }} />)
    expect(document.querySelector('pre.muted')?.textContent).toBe('go test ./...')
  })
})

describe('ToolCallCard headers', () => {
  it('renders a shell card header from its label', () => {
    render(<ToolCallCard call={{ id: 'shell-1', name: 'bash', label: '! make test' }} />)
    expect(screen.getByText('! make test')).toBeInTheDocument()
    expect(screen.queryByText('bash')).not.toBeInTheDocument()
  })

  it('keeps the tool name for agent calls', () => {
    render(<ToolCallCard call={{ id: 'c1', name: 'bash', input: { command: 'go build ./...' } }} />)
    expect(screen.getByText('bash')).toBeInTheDocument()
  })
})

describe('ToolCallCard output preview', () => {
  it('counts a long committed output instead of previewing it', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          result: { callId: 'c1', text: longBody(31), images: [], isError: false },
        }}
      />,
    )
    expect(screen.getByText('Output · 31 lines')).toBeInTheDocument()
  })

  it('previews a short output', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          result: { callId: 'c1', text: 'all good', images: [], isError: false },
        }}
      />,
    )
    expect(screen.getByText('all good')).toBeInTheDocument()
  })

  it('previews an output at the threshold', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          result: { callId: 'c1', text: longBody(30), images: [], isError: false },
        }}
      />,
    )
    expect(screen.getByText('line 0')).toBeInTheDocument()
    expect(screen.queryByText('Output · 30 lines')).not.toBeInTheDocument()
  })

  it('keeps the first-line preview for streamed output', () => {
    render(<ToolCallCard call={{ id: 'c1', name: 'bash', outputs: [longBody(31)] }} />)
    expect(screen.getByText('line 0')).toBeInTheDocument()
    expect(screen.queryByText('Output · 31 lines')).not.toBeInTheDocument()
  })

  it('reveals a counted body behind the header toggle', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          result: { callId: 'c1', text: longBody(31), images: [], isError: false },
        }}
      />,
    )
    await user.click(screen.getByRole('button'))
    expect(container.querySelector('.tool-body > pre')?.textContent).toContain('line 30')
    expect(screen.queryByText('Output · 31 lines')).not.toBeInTheDocument()
  })
})
