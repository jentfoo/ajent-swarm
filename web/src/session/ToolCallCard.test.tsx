import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { SubAgentChips, ToolCallCard } from './ToolCallCard'
import type { AgentJobs } from './useAgentJobs'
import type { ActivityRow, AgentJob } from '../api/types'

// A collapsed card shows its header alone, so input and output assertions open
// the card first. Edit calls render one unnumbered diff per op instead of
// escaped JSON, every other shape pretty-prints, and long committed outputs
// collapse behind the header's line count. Open/close behavior is covered from
// the outside by EntryBlock and LiveStreamBlock tests, this file pins the card.

type CardCall = ComponentProps<typeof ToolCallCard>['call']
type CardProps = ComponentProps<typeof ToolCallCard>

function rows(kind: string): string[] {
  return Array.from(document.querySelectorAll(`.diff-line.${kind} .diff-text`)).map(
    (el) => el.textContent ?? '',
  )
}

function longBody(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')
}

// openCard renders a collapsed card and clicks its header, the state every
// body assertion needs
async function openCard(props: CardProps) {
  const user = userEvent.setup()
  const view = render(<ToolCallCard {...props} />)
  await user.click(screen.getByRole('button'))
  return view
}

const pathChip = (): string | undefined => document.querySelector('.diff-path')?.textContent

const doneCall = (text: string): CardCall => ({
  id: 'c1',
  name: 'bash',
  input: { command: 'go test' },
  result: { callId: 'c1', text, images: [], isError: false },
})

describe('ToolCallCard inputs', () => {
  it('renders edit input as per-op diffs', async () => {
    await openCard({
      call: {
        id: 'c1',
        name: 'edit',
        input: { path: 'a.go', edits: [{ oldText: 'one\n', newText: 'ONE\n' }] },
      },
    })
    expect(pathChip()).toBe('a.go')
    expect(rows('del')).toEqual(['one'])
    expect(rows('add')).toEqual(['ONE'])
    // the escaped JSON never renders for a parseable edit
    expect(document.querySelector('pre.muted')).toBeNull()
  })

  it('counts multi-op edits on the path chip', async () => {
    await openCard({
      call: {
        id: 'c1',
        name: 'edit',
        input: {
          path: 'a.go',
          edits: [
            { oldText: 'one\n', newText: 'ONE\n' },
            { oldText: 'two\n', newText: 'TWO\n' },
          ],
        },
      },
    })
    expect(pathChip()).toBe('a.go · 2 edits')
    expect(document.querySelectorAll('.diff-pre')).toHaveLength(2)
  })

  it('unwraps string-encoded edits', async () => {
    await openCard({
      call: {
        id: 'c1',
        name: 'edit',
        input: { path: 'a.go', edits: JSON.stringify([{ oldText: 'x\n', newText: 'y\n' }]) },
      },
    })
    expect(rows('add')).toEqual(['y'])
  })

  it('drops the op diffs on a gated edit, keeping the path', async () => {
    // the full-file diff rides above the dialog, an unnumbered fragment copy
    // would only repeat it
    await openCard({
      gated: true,
      call: {
        id: 'c1',
        name: 'edit',
        input: { path: 'a.go', edits: [{ oldText: 'one\n', newText: 'ONE\n' }] },
      },
    })
    expect(pathChip()).toBe('a.go')
    expect(document.querySelector('.diff-pre')).toBeNull()
  })

  it('keeps op diffs on a failed edit', async () => {
    // the diff is the requested change, worth showing beside the fault's real
    // match lines in the body; fragment rows render unnumbered like anywhere else
    await openCard({
      call: {
        id: 'c1',
        name: 'edit',
        input: { path: 'a.go', edits: [{ oldText: 'one\n', newText: 'ONE\n' }] },
        result: {
          callId: 'c1',
          text: '',
          images: [],
          isError: true,
          fault: 'old text not found near line 12',
        },
      },
    })
    expect(document.querySelector('.tool-card')).toHaveClass('error')
    expect(rows('del')).toEqual(['one'])
    expect(rows('add')).toEqual(['ONE'])
    expect(document.querySelector('.diff-num')).toBeNull()
  })

  it('pretty-prints unparseable edit input', async () => {
    await openCard({
      call: { id: 'c1', name: 'edit', input: { path: 'a.go', edits: [{ oldText: 4 }] } },
    })
    const pre = document.querySelector('pre.muted')
    expect(pre?.textContent).toContain('"path": "a.go"')
    expect(pre?.textContent).toContain('"oldText": 4')
  })

  it('pretty-prints object inputs with two-space indent', async () => {
    await openCard({ call: { id: 'c1', name: 'bash', input: { cmd: 'go build ./...' } } })
    expect(document.querySelector('pre.muted')?.textContent).toBe('{\n  "cmd": "go build ./..."\n}')
  })

  it('keeps string inputs verbatim', async () => {
    await openCard({ call: { id: 'c1', name: 'bash', input: 'go test ./...' } })
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

describe('ToolCallCard summary', () => {
  const summary = (): string | undefined => document.querySelector('.tool-summary')?.textContent

  it.each([
    {
      name: 'shell command',
      tool: 'bash',
      input: { command: 'go build ./...' },
      want: 'go build ./...',
    },
    { name: 'shell cmd key', tool: 'bash', input: { cmd: 'ls' }, want: 'ls' },
    { name: 'bare string input', tool: 'bash', input: 'ls -la', want: 'ls -la' },
    { name: 'double-encoded input', tool: 'bash', input: '{"command":"ls"}', want: 'ls' },
    { name: 'edit path', tool: 'edit', input: { path: 'a.go' }, want: 'a.go' },
    { name: 'read path', tool: 'Read', input: { path: 'src/main.go' }, want: 'src/main.go' },
    { name: 'write path', tool: 'write_file', input: { path: 'notes.md' }, want: 'notes.md' },
    { name: 'grep pattern', tool: 'grep', input: { pattern: 'TODO', path: 'src' }, want: 'TODO' },
    { name: 'grep prefers pattern', tool: 'grep', input: { pattern: 'a', query: 'b' }, want: 'a' },
    { name: 'find pattern', tool: 'find', input: { pattern: '*.go', path: '.' }, want: '*.go' },
    { name: 'search query', tool: 'repo_search', input: { query: 'retry' }, want: 'retry' },
    {
      name: 'first line only',
      tool: 'bash',
      input: { command: 'make test\nmake lint' },
      want: 'make test',
    },
  ])('shows the $name', ({ tool, input, want }) => {
    render(<ToolCallCard call={{ id: 'c1', name: tool, input }} />)
    expect(summary()).toBe(want)
  })

  it.each([
    { name: 'unknown tool with known keys', tool: 'ask_user', input: { path: 'x', pattern: 'y' } },
    { name: 'prototype key as tool name', tool: 'constructor', input: { command: 'ls' } },
    { name: 'known tool without known keys', tool: 'read', input: { file_path: 'x' } },
    { name: 'blank value', tool: 'grep', input: { pattern: '   ' } },
    { name: 'non-string value', tool: 'read', input: { path: 42 } },
    { name: 'array input', tool: 'bash', input: ['ls'] },
    { name: 'null input', tool: 'bash', input: null },
    { name: 'no input yet', tool: 'bash', input: undefined },
  ])('renders no summary for $name', ({ tool, input }) => {
    render(<ToolCallCard call={{ id: 'c1', name: tool, input }} />)
    expect(document.querySelector('.tool-summary')).toBeNull()
  })

  it('caps a long summary with an ellipsis', () => {
    render(<ToolCallCard call={{ id: 'c1', name: 'bash', input: { command: 'x'.repeat(100) } }} />)
    expect(summary()).toHaveLength(80)
    expect(summary()).toMatch(/…$/)
  })

  it('keeps the shell label in place of a summary', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          shell: true,
          label: '! make test',
          input: { command: 'make test' },
        }}
      />,
    )
    expect(screen.getByText('! make test')).toBeInTheDocument()
    expect(document.querySelector('.tool-summary')).toBeNull()
  })
})

describe('ToolCallCard compose progress', () => {
  it('shows size feedback while composing', () => {
    render(
      <ToolCallCard
        call={{ id: 'c1', name: 'write', progress: { path: 'notes.go', lines: 132, bytes: 4203 } }}
      />,
    )
    expect(screen.getByText('132 lines · 4.1kb')).toHaveClass('tool-preview')
  })

  it('hides once full input arrives', () => {
    render(
      <ToolCallCard
        call={{ id: 'c1', name: 'write', progress: { lines: 5, bytes: 300 }, input: { path: 'a' } }}
      />,
    )
    expect(screen.queryByText('5 lines · 300b')).not.toBeInTheDocument()
  })

  it('hides at the result', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'write',
          progress: { lines: 5, bytes: 300 },
          result: { callId: 'c1', text: '', images: [], isError: false },
        }}
      />,
    )
    expect(screen.queryByText('5 lines · 300b')).not.toBeInTheDocument()
  })
})

describe('ToolCallCard shell lifecycle', () => {
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

  // the open body carries its own copy button, so the toggle is named
  const header = () => screen.getByRole('button', { name: /! make test/ })

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
    expect(container.querySelector('.tool-body')).toBeNull()
    expect(screen.getByText('ok')).toBeInTheDocument() // first-line preview
  })

  it('keeps a manual collapse across the finish', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(<ToolCallCard call={shellCall()} />)
    await user.click(header())
    expect(container.querySelector('.tool-body')).toBeNull()

    rerender(
      <ToolCallCard
        call={shellCall({
          result: { callId: 'shell-1', text: 'ok', images: [], isError: false },
        })}
      />,
    )
    expect(container.querySelector('.tool-body')).toBeNull()
    expect(screen.getByText('staged - rides your next message')).toBeInTheDocument()
  })

  it('keeps a manual open past the finish', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(<ToolCallCard call={shellCall()} />)
    await user.click(header()) // collapse
    await user.click(header()) // reopen
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
    render(<ToolCallCard call={doneCall('all good')} />)
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

  it('previews a fault instead of counting it', () => {
    // the fault's head names what went wrong, keep it visible while collapsed
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          result: { callId: 'c1', text: '', images: [], isError: true, fault: longBody(31) },
        }}
      />,
    )
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

describe('ToolCallCard disclosure', () => {
  it('keeps a collapsed card to its header', () => {
    // the summary and the output preview stand in for the arguments until asked
    const { container } = render(<ToolCallCard call={doneCall('all good')} />)
    expect(container.querySelector('.tool-body')).toBeNull()
    expect(screen.getByText('go test')).toHaveClass('tool-summary')
    expect(screen.getByText('all good')).toHaveClass('tool-preview')
  })

  it('renders the input and output once opened', async () => {
    const { container } = await openCard({ call: doneCall('all good') })
    expect(container.querySelector('.tool-body pre.muted')?.textContent).toBe(
      '{\n  "command": "go test"\n}',
    )
    expect(container.querySelector('.tool-body-bar + pre')?.textContent).toBe('all good')
  })

  it('flips aria-expanded with the body', async () => {
    const user = userEvent.setup()
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'bash',
          result: { callId: 'c1', text: longBody(31), images: [], isError: false },
        }}
      />,
    )

    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('announces a streaming shell body open', () => {
    render(<ToolCallCard call={{ id: 'c1', name: 'bash', shell: true, outputs: ['ok\n'] }} />)
    expect(screen.getByRole('button', { name: /bash/ })).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('ToolCallCard output copy', () => {
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

  it('copies the open body text', async () => {
    const { user, writes } = setupCopyUser(async () => {})
    render(<ToolCallCard call={doneCall('all good\n')} />)
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button')) // the header, the only button while closed
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writes).toHaveBeenCalledWith('all good\n')
  })

  it('offers no copy without a body', async () => {
    await openCard({ call: { id: 'c1', name: 'read', input: { path: 'a.go' } } })
    expect(document.querySelector('.tool-body')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
  })
})

describe('ToolCallCard sub-agent jobs', () => {
  const chipRow = (key: string): ActivityRow => ({ key, text: `${key}  reading files`, rank: 0 })

  // chip finds one job's live-line element, the double space in upstream rows
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
