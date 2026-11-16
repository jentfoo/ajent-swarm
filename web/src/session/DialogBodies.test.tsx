import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MultiPickList,
  ResolvedChip,
  TextAnswer,
  outcomeChipTtlMs,
  useMultiPick,
} from './DialogBodies'
import { coarseImport } from '../test/matchMedia'
import type { DialogOutcome } from '../state/eventApplier'

// The shared dialog bodies both docks render: the free-text answer, the multi
// checkbox list with its chrome-placed confirm, and the answered-elsewhere
// chip that leaves the store, not just the view.

function MultiProbe() {
  const { picked, toggle } = useMultiPick()
  return (
    <MultiPickList options={['a', 'b']} picked={picked} onToggle={toggle}>
      <button type="button" onClick={() => toggle(1)}>
        slot
      </button>
    </MultiPickList>
  )
}

// heldSend holds one resolve in flight until released, pinning draft timing.
function heldSend() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { onSend: () => gate.then(() => true), release }
}

describe('TextAnswer', () => {
  it('names the answer input for screen readers', () => {
    render(<TextAnswer busy={false} chat onSend={() => Promise.resolve(true)} />)

    expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'Dialog answer')
  })

  it('sends the typed text and clears it once landed', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => true)
    render(<TextAnswer busy={false} chat={false} onSend={onSend} />)

    await user.type(screen.getByRole('textbox'), 'my answer')
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onSend).toHaveBeenCalledWith('my answer')
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
  })

  it('refuses whitespace-only and busy answers', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const { rerender } = render(<TextAnswer busy={false} chat={false} onSend={onSend} />)

    await user.type(screen.getByRole('textbox'), '   ')
    expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled()

    rerender(<TextAnswer busy chat={false} onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps typed text through a submit while busy', () => {
    const onSend = vi.fn()
    render(<TextAnswer busy chat={false} onSend={onSend} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'my answer' } })

    // Enter repeats submit past the disabled answer button
    fireEvent.submit(input.closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('my answer')
  })

  it('marks a chat answer when the toggle is on', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => true)
    render(<TextAnswer busy={false} chat onSend={onSend} />)

    await user.type(screen.getByRole('textbox'), 'own words')
    await user.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Answer (chat)' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: /Answer/ }))
    expect(onSend).toHaveBeenCalledWith('own words')
  })

  it.each([
    ['keeps the caret off by default', false],
    ['takes the caret when allowed', true],
  ])('%s', (_name, autoFocus) => {
    render(
      <TextAnswer
        busy={false}
        chat={false}
        autoFocus={autoFocus}
        onSend={() => Promise.resolve(true)}
      />,
    )
    const input = screen.getByRole('textbox')
    if (autoFocus) expect(input).toHaveFocus()
    else expect(document.activeElement).toBe(document.body)
  })

  it('keeps the typed draft when a resolve is refused', async () => {
    const user = userEvent.setup()
    render(<TextAnswer busy={false} chat={false} onSend={() => Promise.resolve(false)} />)

    await user.type(screen.getByRole('textbox'), 'my answer')
    await user.click(screen.getByRole('button', { name: 'Answer' }))

    expect(screen.getByRole('textbox')).toHaveValue('my answer')
  })

  it('holds the draft through a landed resolve still in flight', async () => {
    const user = userEvent.setup()
    const { onSend, release } = heldSend()
    render(<TextAnswer busy={false} chat={false} onSend={onSend} />)

    await user.type(screen.getByRole('textbox'), 'my answer')
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    expect(screen.getByRole('textbox')).toHaveValue('my answer')

    await act(async () => release())
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
  })

  it('keeps edits typed while a resolve was in flight', async () => {
    const user = userEvent.setup()
    const { onSend, release } = heldSend()
    render(<TextAnswer busy={false} chat={false} onSend={onSend} />)

    await user.type(screen.getByRole('textbox'), 'first')
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    await user.type(screen.getByRole('textbox'), ' edited')

    await act(async () => release())
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('first edited'))
  })
})

// coarseTextAnswer re-imports TextAnswer under the coarse-pointer stub, since
// the touch gate reads once at module scope.
async function coarseTextAnswer(): Promise<typeof TextAnswer> {
  return (await coarseImport(() => import('./DialogBodies'))).TextAnswer
}

describe('TextAnswer touch press', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends one tap with the keyboard up', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => true)
    const CoarseTextAnswer = await coarseTextAnswer()
    render(<CoarseTextAnswer busy={false} chat={false} onSend={onSend} />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'my answer')
    await user.click(screen.getByRole('button', { name: 'Answer' }))

    expect(onSend).toHaveBeenCalledWith('my answer')
    // the press never moved focus, so the keyboard stays up
    expect(input).toHaveFocus()
  })

  it('dismisses the keyboard on an empty tap', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => true)
    const CoarseTextAnswer = await coarseTextAnswer()
    render(<CoarseTextAnswer busy={false} chat={false} onSend={onSend} />)

    const input = screen.getByRole('textbox')
    input.focus()
    const answer = screen.getByRole('button', { name: 'Answer' })

    // the empty draft keeps the button tappable with the disabled look, and
    // the tap closes the keyboard without answering
    expect(answer).toBeEnabled()
    expect(answer).toHaveClass('keyboard-dismiss')
    await user.click(answer)
    expect(onSend).not.toHaveBeenCalled()
    expect(input).not.toHaveFocus()
  })

  it('keeps a busy answer really disabled', async () => {
    const CoarseTextAnswer = await coarseTextAnswer()
    render(<CoarseTextAnswer busy chat={false} onSend={() => Promise.resolve(true)} />)

    const answer = screen.getByRole('button', { name: 'Answer' })
    expect(answer).toBeDisabled()
    expect(answer).not.toHaveClass('keyboard-dismiss')
  })
})

describe('MultiPickList', () => {
  it('toggles membership through the shared hook and renders the confirm slot', async () => {
    const user = userEvent.setup()
    render(<MultiProbe />)

    const boxes = screen.getAllByRole('checkbox')
    await user.click(boxes[0])
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()

    // the children slot rides inside the list, where each chrome places it
    expect(screen.getByRole('button', { name: 'slot' }).closest('.multipick')).not.toBeNull()

    await user.click(boxes[0])
    expect(boxes[0]).not.toBeChecked()
  })
})

describe('ResolvedChip', () => {
  const outcome: DialogOutcome = { id: 9, answered: true, cancelled: false, index: 1 }

  it('dismisses itself through the callback after the shared ttl', async () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      render(<ResolvedChip outcome={outcome} onDismiss={onDismiss} />)

      act(() => {
        vi.advanceTimersByTime(outcomeChipTtlMs - 1)
      })
      expect(onDismiss).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(onDismiss).toHaveBeenCalledWith(9)
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the timer across parent re-renders', async () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      const view = render(<ResolvedChip outcome={outcome} onDismiss={onDismiss} />)
      act(() => {
        vi.advanceTimersByTime(outcomeChipTtlMs / 2)
      })
      view.rerender(<ResolvedChip outcome={outcome} onDismiss={onDismiss} />)
      act(() => {
        vi.advanceTimersByTime(outcomeChipTtlMs / 2)
      })
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses on click', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(<ResolvedChip outcome={outcome} onDismiss={onDismiss} />)

    await user.click(screen.getByRole('status'))
    expect(onDismiss).toHaveBeenCalledWith(9)
  })

  it('reads terse with the detail on hover, or inline for touch', () => {
    const { rerender } = render(<ResolvedChip outcome={outcome} onDismiss={() => {}} />)
    const chip = screen.getByRole('status')
    expect(chip).toHaveTextContent('Dialog answered')
    expect(chip).toHaveAttribute('title', 'Dialog 9 answered elsewhere — answered: option 2')

    rerender(<ResolvedChip outcome={outcome} onDismiss={() => {}} inlineDetail />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Dialog 9 answered elsewhere — answered: option 2',
    )
  })

  it.each([
    [
      'multi picks',
      { id: 1, answered: true, cancelled: false, indexes: [0, 2] },
      'answered: options 1, 3',
    ],
    ['cancelled', { id: 2, answered: false, cancelled: true }, 'cancelled'],
    ['settled quietly', { id: 3, answered: false, cancelled: false }, 'closed'],
  ])('names %s inline', (_name, o: DialogOutcome, detail) => {
    render(<ResolvedChip outcome={o} onDismiss={() => {}} inlineDetail />)
    expect(screen.getByRole('status')).toHaveTextContent(
      `Dialog ${o.id} answered elsewhere — ${detail}`,
    )
  })
})
