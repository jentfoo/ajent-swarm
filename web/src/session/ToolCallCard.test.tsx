import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { SubAgentChips, ToolCallCard } from './ToolCallCard'
import type { AgentJobs } from './useAgentJobs'
import type { ActivityRow, AgentJob } from '../api/types'

// Input rendering: edit calls render one diff per op instead of escaped JSON,
// every other shape pretty-prints, and long committed outputs collapse behind
// the header's line count. Open/close behavior is covered from the outside by
// EntryBlock and LiveStreamBlock tests; this file pins the body itself.

function rows(kind: string): string[] {
  return Array.from(document.querySelectorAll(`.diff-line.${kind} .diff-text`)).map(
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

describe('ToolCallCard shell lifecycle', () => {
  type CardCall = ComponentProps<typeof ToolCallCard>['call']

  function shellCall(overrides: Partial<CardCall> = {}): CardCall {
    return {
      id: 'shell-1',
      name: 'bash',
      label: '! make test',
      shell: true,
      outputs: ['ok\n'],
      ...overrides,
    }
  }

  it('paints a streaming shell body open', () => {
    const { container } = render(<ToolCallCard call={shellCall()} />)
    expect(container.querySelector('.tool-body pre')?.textContent).toBe('ok\n')
    expect(container.querySelector('.tool-card')).toHaveClass('shell')
  })

  it('collapses at rest behind the staged badge', () => {
    const { container, rerender } = render(<ToolCallCard call={shellCall()} />)
    rerender(
      <ToolCallCard
        call={shellCall({
          result: { callId: 'shell-1', text: 'ok', images: [], isError: false },
        })}
      />,
    )
    expect(screen.getByText('staged - rides your next message')).toHaveClass('badge warn')
    expect(container.querySelector('.tool-body pre')).toBeNull()
    expect(screen.getByText('ok')).toBeInTheDocument() // first-line preview
  })

  it('keeps a manual collapse across the finish', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(<ToolCallCard call={shellCall()} />)
    await user.click(screen.getByRole('button'))
    expect(container.querySelector('.tool-body pre')).toBeNull()

    rerender(
      <ToolCallCard
        call={shellCall({
          result: { callId: 'shell-1', text: 'ok', images: [], isError: false },
        })}
      />,
    )
    expect(container.querySelector('.tool-body pre')).toBeNull()
    expect(screen.getByText('staged - rides your next message')).toBeInTheDocument()
  })

  it('keeps a manual open past the finish', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(<ToolCallCard call={shellCall()} />)
    await user.click(screen.getByRole('button')) // collapse
    await user.click(screen.getByRole('button')) // reopen
    rerender(
      <ToolCallCard
        call={shellCall({
          result: { callId: 'shell-1', text: 'ok', images: [], isError: false },
        })}
      />,
    )
    expect(container.querySelector('.tool-body pre')?.textContent).toBe('ok\n')
  })

  it('badges an excluded run output not sent', () => {
    const { container } = render(
      <ToolCallCard
        call={shellCall({
          label: '!! git status',
          excluded: true,
          result: { callId: 'shell-1', text: 'clean', images: [], isError: false },
        })}
      />,
    )
    expect(screen.getByText('output not sent to the model')).toHaveClass('badge danger')
    expect(container.querySelector('.tool-card')).toHaveClass('shell excluded')
    expect(screen.queryByText('done')).not.toBeInTheDocument()
  })

  it('stays failed when an excluded run errors', () => {
    render(
      <ToolCallCard
        call={shellCall({
          label: '!! bad',
          excluded: true,
          result: { callId: 'shell-1', text: 'boom', images: [], isError: true },
        })}
      />,
    )
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.queryByText('output not sent to the model')).not.toBeInTheDocument()
  })

  it('keeps the no-result badge on a shell card without a result', () => {
    render(<ToolCallCard call={shellCall({ closed: true })} />)
    expect(screen.getByText('no result')).toBeInTheDocument()
  })

  it('leaves agent cards manual-only with the done badge', () => {
    const { container, rerender } = render(
      <ToolCallCard call={{ id: 'c1', name: 'bash', outputs: ['x'] }} />,
    )
    expect(container.querySelector('.tool-body')).toBeNull()
    rerender(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          result: { callId: 'c1', text: 'x', images: [], isError: false },
        }}
      />,
    )
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(container.querySelector('.tool-card.shell')).toBeNull()
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

describe('ToolCallCard sub-agent jobs', () => {
  const chipRow = (key: string): ActivityRow => ({ key, text: `${key}  reading files`, rank: 0 })

  // chip finds one job's live-line element; the double space in upstream rows
  // defeats getByText's default whitespace collapsing.
  const chip = (key: string): Element | null =>
    document.querySelector(`.sub-agent-chip[data-sub-key="${key}"]`)

  const job = (id: string, status: AgentJob['status'], elapsedMs?: number): AgentJob => ({
    id,
    status,
    elapsedMs,
  })

  // jobsView builds the pull listing the surfaces consume.
  const jobsView = (
    over: {
      jobs?: AgentJob[]
      available?: boolean
      stop?: (id?: string) => void
      stopping?: boolean
    } = {},
  ): AgentJobs => ({
    byId: new Map((over.jobs ?? [job('sub-1', 'running', 120_000)]).map((j) => [j.id, j])),
    available: over.available ?? true,
    stop: over.stop ?? vi.fn(),
    stopping: over.stopping ?? false,
  })

  it('renders record status and elapsed', () => {
    render(<SubAgentChips rows={[chipRow('sub-1')]} overflow={0} jobs={jobsView()} />)
    expect(chip('sub-1')?.textContent).toBe('sub-1  reading files')
    const status = screen.getByText('running', { selector: '[data-sub-status]' })
    expect(status).toHaveClass('accent')
    expect(screen.getByText('2m00s')).toBeInTheDocument()
  })

  it('stops through the row key', async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    render(<SubAgentChips rows={[chipRow('sub-1')]} overflow={0} jobs={jobsView({ stop })} />)
    await user.click(screen.getByRole('button', { name: 'Stop sub-1' }))
    expect(stop).toHaveBeenCalledWith('sub-1')
  })

  it('stops without a record', () => {
    render(<SubAgentChips rows={[chipRow('sub-2')]} overflow={0} jobs={jobsView({ jobs: [] })} />)
    expect(screen.getByRole('button', { name: 'Stop sub-2' })).toBeInTheDocument()
  })

  it('finished records lose the stop', () => {
    render(
      <SubAgentChips
        rows={[chipRow('sub-1')]}
        overflow={0}
        jobs={jobsView({ jobs: [job('sub-1', 'aborted')] })}
      />,
    )
    expect(screen.getByText('aborted')).toHaveClass('warn')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('disables stops while stopping', () => {
    render(
      <SubAgentChips rows={[chipRow('sub-1')]} overflow={0} jobs={jobsView({ stopping: true })} />,
    )
    expect(screen.getByRole('button', { name: 'Stop sub-1' })).toBeDisabled()
  })

  it('hides surfaces when unavailable', () => {
    render(
      <SubAgentChips
        rows={[chipRow('sub-1')]}
        overflow={0}
        jobs={jobsView({ available: false })}
      />,
    )
    expect(chip('sub-1')?.textContent).toBe('sub-1  reading files')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(document.querySelector('[data-sub-status]')).toBeNull()
  })

  it('renders the row text alone', () => {
    render(<SubAgentChips rows={[chipRow('sub-1')]} overflow={0} />)
    expect(chip('sub-1')?.textContent).toBe('sub-1  reading files')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('stops from the poll row', async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    render(
      <ToolCallCard
        call={{ id: 'c9', name: 'agent_poll', input: { id: 'sub-1' } }}
        agents={[chipRow('sub-1')]}
        agentJobs={jobsView({ stop })}
      />,
    )
    expect(chip('sub-1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop sub-1' }))
    expect(stop).toHaveBeenCalledWith('sub-1')
  })
})
