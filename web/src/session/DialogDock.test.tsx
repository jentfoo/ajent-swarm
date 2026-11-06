import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DialogDock } from './DialogDock'
import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'

// The card variant maps off the shape flags, never on kind: options answer by
// index, multi answers indexes with an empty confirm allowed, text carries a
// chat toggle when offered, secrets mask input, cancel exists everywhere.

const base = (overrides: Partial<InteractionPending>): InteractionPending => ({
  id: 42,
  kind: 'pick',
  prompt: 'Proceed?',
  ...overrides,
})

const noop = () => {}

// renderDock mounts one dock shape; autoFocusDialogs false stands in for a
// background pane. Returns the view so a case can rerender the stack.
function renderDock(dialogs: InteractionPending[], autoFocusDialogs?: boolean) {
  return render(
    <DialogDock
      sessionId="01S"
      dialogs={dialogs}
      outcomes={[]}
      autoFocusDialogs={autoFocusDialogs}
      onAnsweredLocally={noop}
      onOutcomeDismissed={noop}
    />,
  )
}

function dock(dialogs: InteractionPending[], outcomes: DialogOutcome[] = []) {
  const onAnsweredLocally = vi.fn()
  const onOutcomeDismissed = vi.fn()
  render(
    <DialogDock
      sessionId="01S"
      dialogs={dialogs}
      outcomes={outcomes}
      onAnsweredLocally={onAnsweredLocally}
      onOutcomeDismissed={onOutcomeDismissed}
    />,
  )
  return { onAnsweredLocally, onOutcomeDismissed }
}

function stubFetch(reply: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return Response.json(reply)
    }),
  )
  return bodies
}

describe('DialogDock shape mapping', () => {
  it.each([
    ['button list for options', base({ options: ['allow', 'deny'] }), 'allow'],
    ['checkboxes plus confirm for multi', base({ options: ['a', 'b'], multi: true }), 'Confirm'],
    ['text input with chat toggle', base({ text: true, chat: true }), 'reply in my own words'],
    ['masked input for secrets', base({ text: true, secret: true }), 'Answer'],
  ])('renders %s', (_name, dialog, label) => {
    dock([dialog])
    expect(screen.getByText(dialog.prompt)).toBeInTheDocument()
    if (dialog.multi) {
      expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    }
    expect(screen.getByText(label)).toBeInTheDocument()
    // cancel exists on every variant
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('answers a single option by index', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    dock([base({ options: ['allow', 'deny'] })])
    await user.click(screen.getByRole('button', { name: 'deny' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, index: 1 })
  })

  it('confirms multi answers by indexes, empty included', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    dock([base({ options: ['a', 'b'], multi: true })])
    await user.click(screen.getAllByRole('checkbox')[1]!)
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, indexes: [1] })

    // confirming with nothing picked is a valid empty list
    const { unmount } = render(
      <DialogDock
        sessionId="01S"
        dialogs={[base({ id: 43, options: ['a', 'b'], multi: true })]}
        outcomes={[]}
        onAnsweredLocally={() => {}}
        onOutcomeDismissed={() => {}}
      />,
    )
    const cards = screen.getAllByText('Proceed?')
    const secondCard = cards[1]!.closest<HTMLElement>('.dialog-card')!
    await user.click(within(secondCard).getByRole('button', { name: 'Confirm' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 43, indexes: [] })
    unmount()
  })

  it('marks a chat answer when the toggle is on', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    dock([base({ text: true, chat: true })])
    await user.type(screen.getByRole('textbox'), 'my own words')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /Answer/ }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, text: 'my own words', chat: true })
  })

  it('masks secret answers', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    dock([base({ text: true, secret: true })])
    const input = screen.getByDisplayValue('')
    expect(input).toHaveAttribute('type', 'password')
    await user.type(input, 's3cret')
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, text: 's3cret' })
  })

  it('cancels by id from every shape', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    dock([base({ options: ['a'] }), base({ id: 43, text: true })])
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)
    expect(bodies.at(-1)).toEqual({ dialogId: 42, cancel: true })
  })

  it('treats a settled refusal as benign', async () => {
    const user = userEvent.setup()
    // 409 with the wire's settled code: the first answer already won
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'settled', message: 'first answer won' }, { status: 409 }),
      ),
    )
    dock([base({ options: ['a'] })])
    await user.click(screen.getByRole('button', { name: 'a' }))
    // no error surfaced: the outcome is a resolved state, never an error
    expect(screen.queryByText(/settled|failed|Resolve failed/i)).not.toBeInTheDocument()
  })

  it('shows outcomes answered elsewhere as resolved states', () => {
    dock([], [{ id: 9, answered: true, cancelled: false, index: 1 }])
    const chip = screen.getByText('Dialog answered')
    // the terse line keeps its detail one hover away: which dialog and the pick
    expect(chip).toHaveAttribute('title', 'Dialog 9 answered elsewhere — answered: option 2')

    const { unmount } = render(
      <DialogDock
        sessionId="01S"
        dialogs={[]}
        outcomes={[{ id: 10, answered: false, cancelled: true }]}
        onAnsweredLocally={() => {}}
        onOutcomeDismissed={() => {}}
      />,
    )
    expect(screen.getByText('Dialog cancelled')).toBeInTheDocument()
    unmount()
  })

  it('summarizes multi picks on hover', () => {
    dock([], [{ id: 12, answered: true, cancelled: false, indexes: [0, 2] }])
    const chip = screen.getByText('Dialog answered')
    expect(chip).toHaveAttribute('title', 'Dialog 12 answered elsewhere — answered: options 1, 3')
  })

  it('dismisses an outcome on click and never re-renders it', async () => {
    const user = userEvent.setup()
    const { onOutcomeDismissed } = dock([], [{ id: 9, answered: true, cancelled: false, index: 1 }])
    await user.click(screen.getByText('Dialog answered'))
    expect(onOutcomeDismissed).toHaveBeenCalledWith(9)
  })

  it('auto-dismisses an outcome after a moment', async () => {
    vi.useFakeTimers()
    try {
      const { onOutcomeDismissed } = dock([], [{ id: 11, cancelled: true, answered: false }])
      expect(screen.getByText('Dialog cancelled')).toBeInTheDocument()

      await act(() => vi.advanceTimersByTimeAsync(4_000))
      expect(onOutcomeDismissed).toHaveBeenCalledWith(11)
    } finally {
      vi.useRealTimers() // later async tests need the real clock back
    }
  })

  it('lists several open dialogs oldest first', () => {
    dock([base({ id: 7, prompt: 'first question' }), base({ id: 8, prompt: 'second question' })])
    const first = screen.getByText('first question')
    const second = screen.getByText('second question')
    // document order is the oldest-first dock order
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// The permit note flow: a permit card's Deny and Allow with note answer in
// one tap, recording an intent that resolves the barrier's follow-up ask —
// typed text as the note, empty as a cancel — without ever rendering it.
// Without an intent the ask renders for hand answering, as today.
describe('DialogDock permit note flow', () => {
  const permitDialog = (id: number): InteractionPending => ({
    id,
    kind: 'decision',
    prompt: 'Allow `rm` tool call?',
    options: ['Allow', 'Allow with note', 'Deny'],
  })

  const followUpAsk = (id: number, prompt: string): InteractionPending => ({
    id,
    kind: 'ask',
    prompt,
    text: true,
  })

  function permitDock(dialogs: InteractionPending[]) {
    const onAnsweredLocally = vi.fn()
    const view = render(
      <DialogDock
        sessionId="01S"
        dialogs={dialogs}
        outcomes={[]}
        onAnsweredLocally={onAnsweredLocally}
        onOutcomeDismissed={vi.fn()}
      />,
    )
    const rerenderWith = (next: InteractionPending[]) =>
      view.rerender(
        <DialogDock
          sessionId="01S"
          dialogs={next}
          outcomes={[]}
          onAnsweredLocally={onAnsweredLocally}
          onOutcomeDismissed={vi.fn()}
        />,
      )
    return { onAnsweredLocally, rerenderWith }
  }

  const noteInput = () => screen.getByPlaceholderText('Note for the agent (optional)')

  it('deny with empty note cancels the follow-up ask', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    const { onAnsweredLocally, rerenderWith } = permitDock([permitDialog(7)])
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 2 })

    // the follow-up ask arrives and the pending empty intent cancels it blind
    rerenderWith([followUpAsk(8, 'reason for denying')])
    await vi.waitFor(() => {
      expect(bodies[1]).toEqual({ dialogId: 8, cancel: true })
      expect(onAnsweredLocally).toHaveBeenCalledWith(8)
    })
    // suppressed while the auto-answer round trip lands, so nothing flashes
    expect(screen.queryByText('reason for denying')).not.toBeInTheDocument()
  })

  it('deny with typed note submits the reason', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    const { rerenderWith } = permitDock([permitDialog(7)])
    await user.type(noteInput(), 'too risky')
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 2 })

    rerenderWith([followUpAsk(8, 'reason for denying')])
    await vi.waitFor(() => expect(bodies[1]).toEqual({ dialogId: 8, text: 'too risky' }))
    expect(screen.queryByText('reason for denying')).not.toBeInTheDocument()
  })

  it('allow with note mirrors deny on empty input', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    const { rerenderWith } = permitDock([permitDialog(7)])
    await user.click(screen.getByRole('button', { name: 'Allow with note' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 1 })

    rerenderWith([followUpAsk(8, 'note for allowing')])
    await vi.waitFor(() => expect(bodies[1]).toEqual({ dialogId: 8, cancel: true }))
    expect(screen.queryByText('note for allowing')).not.toBeInTheDocument()
  })

  it('allow with note mirrors deny on typed input', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    const { rerenderWith } = permitDock([permitDialog(7)])
    await user.type(noteInput(), 'only inside build/')
    await user.click(screen.getByRole('button', { name: 'Allow with note' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 1 })

    rerenderWith([followUpAsk(8, 'note for allowing')])
    await vi.waitFor(() => expect(bodies[1]).toEqual({ dialogId: 8, text: 'only inside build/' }))
  })

  it('plain allow never creates an intent', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    const { rerenderWith } = permitDock([permitDialog(7)])
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 0 })

    rerenderWith([followUpAsk(8, 'note for allowing')])
    await act(async () => {}) // flush any wrongly scheduled auto-answer
    expect(bodies).toHaveLength(1)
    // no intent pending: the ask renders for hand answering
    expect(screen.getByText('note for allowing')).toBeInTheDocument()
  })

  it('ask renders by hand without a pending intent', async () => {
    const bodies = stubFetch({ settled: false })
    permitDock([followUpAsk(8, 'reason for denying')])
    await act(async () => {}) // flush any wrongly scheduled auto-answer
    expect(screen.getByText('reason for denying')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled()
    expect(bodies).toHaveLength(0)
  })

  it('failed auto-answer falls back to hand answering', async () => {
    const user = userEvent.setup()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)))
        if (bodies.length === 1) return Response.json({ settled: false })
        return Response.json({ error: 'unexpected', message: 'mid-run fault' }, { status: 500 })
      }),
    )
    const { rerenderWith } = permitDock([permitDialog(7)])
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 2 })

    rerenderWith([followUpAsk(8, 'reason for denying')])
    await vi.waitFor(() => expect(bodies).toHaveLength(2))
    // the intent is spent; the ask renders for hand answering instead of vanishing
    expect(await screen.findByText('reason for denying')).toBeInTheDocument()
  })

  it('auto-answer settled elsewhere stays benign', async () => {
    const user = userEvent.setup()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)))
        if (bodies.length === 1) return Response.json({ settled: false })
        return Response.json({ error: 'settled', message: 'first answer won' }, { status: 409 })
      }),
    )
    const { onAnsweredLocally, rerenderWith } = permitDock([permitDialog(7)])
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    rerenderWith([followUpAsk(8, 'reason for denying')])
    await vi.waitFor(() => expect(bodies).toHaveLength(2))
    await act(async () => {}) // let the benign settle land
    // no error surfaced, and the settled event owns the ask's exit
    expect(screen.queryByText(/settled|failed|Resolve failed/i)).not.toBeInTheDocument()
    expect(screen.queryByText('reason for denying')).not.toBeInTheDocument()
    expect(onAnsweredLocally).toHaveBeenCalledWith(8)
  })

  it('stale intent leaves the ask to hand answering', async () => {
    vi.useFakeTimers()
    try {
      const bodies = stubFetch({ settled: false })
      const { rerenderWith } = permitDock([permitDialog(7)])
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
      })
      expect(bodies[0]).toEqual({ dialogId: 7, index: 2 })

      await act(async () => {
        vi.advanceTimersByTime(10_000) // the intent's clear timer fires
      })
      rerenderWith([followUpAsk(8, 'reason for denying')])
      await act(async () => {})
      expect(bodies).toHaveLength(1)
      expect(screen.getByText('reason for denying')).toBeInTheDocument()
    } finally {
      vi.useRealTimers() // never leak the fake clock into later tests
    }
  })
})

// Digit answers: while the focused pane's head card answers by option index,
// 1..9 pick that option through the same resolve path as a click, and every
// other shape — inputs, multi lists, background panes — leaves the digits to
// the workspace jumps.
describe('DialogDock digit answers', () => {
  // labels clear of decisionNote's permit markers, so the card has no note input
  const optionsDialog = (id: number): InteractionPending => ({
    id,
    kind: 'pick',
    prompt: `question ${id}`,
    options: ['yes', 'no'],
  })
  const permitDialog = (id: number): InteractionPending => ({
    id,
    kind: 'decision',
    prompt: 'Allow `rm`?',
    options: ['Allow', 'Deny'],
  })

  // digit presses one key and flushes the answer round trip it starts
  async function digit(key: string, target: EventTarget = window): Promise<boolean> {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    let prevented = false
    await act(async () => {
      target.dispatchEvent(ev)
      prevented = ev.defaultPrevented
    })
    return prevented
  }

  it('answers the head card option by digit', async () => {
    const bodies = stubFetch({ settled: false })
    renderDock([optionsDialog(7)])

    expect(await digit('2')).toBe(true)
    expect(bodies.at(-1)).toEqual({ dialogId: 7, index: 1 })
  })

  it('records the note intent a clicked deny would', async () => {
    const user = userEvent.setup()
    const bodies = stubFetch({ settled: false })
    const view = renderDock([permitDialog(7)])
    await user.type(screen.getByPlaceholderText('Note for the agent (optional)'), 'too risky')
    // the caret leaves the note, so the digits answer instead of typing
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()

    await digit('2') // Deny rides its note exactly like the button
    expect(bodies[0]).toEqual({ dialogId: 7, index: 1 })
    view.rerender(
      <DialogDock
        sessionId="01S"
        dialogs={[{ id: 8, kind: 'ask', prompt: 'reason for denying', text: true }]}
        outcomes={[]}
        onAnsweredLocally={noop}
        onOutcomeDismissed={noop}
      />,
    )
    await vi.waitFor(() => expect(bodies[1]).toEqual({ dialogId: 8, text: 'too risky' }))
  })

  it('answers nothing past the option list', async () => {
    const bodies = stubFetch({ settled: false })
    renderDock([optionsDialog(7)])

    expect(await digit('5')).toBe(true) // claimed, so no pane jump either
    expect(bodies).toHaveLength(0)
  })

  it('keeps digits while the note input holds the caret', async () => {
    const bodies = stubFetch({ settled: false })
    renderDock([permitDialog(7)])
    const note = screen.getByPlaceholderText('Note for the agent (optional)')
    expect(document.activeElement).toBe(note) // the head card took the caret

    expect(await digit('2', note)).toBe(false)
    expect(bodies).toHaveLength(0)
  })

  it('never claims digits from a background pane', async () => {
    const bodies = stubFetch({ settled: false })
    renderDock([optionsDialog(7)], false)

    expect(await digit('2')).toBe(false) // the digit stays with the pane jumps
    expect(bodies).toHaveLength(0)
  })

  it('leaves multi and text shapes to their own controls', async () => {
    const bodies = stubFetch({ settled: false })
    renderDock([{ ...optionsDialog(7), multi: true }])
    expect(await digit('1')).toBe(false)

    renderDock([{ id: 8, kind: 'input', prompt: 'name?', text: true }])
    expect(await digit('1')).toBe(false)
    expect(bodies).toHaveLength(0)
  })

  it('hands the digits to the next head after one settles', async () => {
    const bodies = stubFetch({ settled: false })
    const view = renderDock([optionsDialog(7), { ...optionsDialog(8), prompt: 'second' }])

    await digit('1')
    expect(bodies.at(-1)).toEqual({ dialogId: 7, index: 0 })
    view.rerender(
      <DialogDock
        sessionId="01S"
        dialogs={[{ ...optionsDialog(8), prompt: 'second' }]}
        outcomes={[]}
        onAnsweredLocally={noop}
        onOutcomeDismissed={noop}
      />,
    )

    await digit('2')
    expect(bodies.at(-1)).toEqual({ dialogId: 8, index: 1 })
  })
})

// Focus policy (dialog-focus-policy.md): autofocus belongs to the focused pane,
// and within a focused dock only the head card takes the caret, on mount. A
// text dialog exercises the rule; the secret variant shares the same path.
describe('DialogDock focus policy', () => {
  const textDialog = (id: number): InteractionPending => ({
    id,
    kind: 'input',
    prompt: `question ${id}`,
    text: true,
  })

  const answerFor = (id: number) =>
    document.querySelector<HTMLInputElement>(`[data-dialog-id="${id}"] input`)

  it('takes the caret on the head answer of a focused dock', () => {
    renderDock([textDialog(1)])
    expect(document.activeElement).toBe(answerFor(1))
  })

  it('renders an unfocused dock without taking focus', () => {
    renderDock([textDialog(1)], false)
    expect(document.activeElement).toBe(document.body)
  })

  it('autofocuses a head secret answer only when focused', () => {
    renderDock([{ ...textDialog(1), secret: true }])
    const input = answerFor(1)
    expect(input).toHaveAttribute('type', 'password')
    expect(document.activeElement).toBe(input)
  })

  it('never autofocuses secrets in an unfocused dock', () => {
    renderDock([{ ...textDialog(1), secret: true }], false)
    const input = answerFor(1)
    expect(input).toHaveAttribute('type', 'password')
    expect(document.activeElement).toBe(document.body)
  })

  it('mounts stacked cards behind the head without focus', () => {
    renderDock([textDialog(1), textDialog(2)])
    expect(document.activeElement).toBe(answerFor(1))
  })

  it('keeps later arrivals from stealing an in-progress answer', async () => {
    const user = userEvent.setup()
    const view = renderDock([textDialog(1)])
    const head = answerFor(1)
    await user.type(head!, 'mid-answer')

    // a second dialog joins the stack while the first answer is being typed
    view.rerender(
      <DialogDock
        sessionId="01S"
        dialogs={[textDialog(1), textDialog(2)]}
        outcomes={[]}
        onAnsweredLocally={noop}
        onOutcomeDismissed={noop}
      />,
    )
    expect(answerFor(2)).not.toBeNull()
    expect(document.activeElement).toBe(head)
  })

  it('never promotes a stacked answer to the caret', () => {
    const view = renderDock([textDialog(1), textDialog(2)])
    // the head settles elsewhere; its neighbor was mounted unfocused and stays so
    view.rerender(
      <DialogDock
        sessionId="01S"
        dialogs={[textDialog(2)]}
        outcomes={[]}
        onAnsweredLocally={noop}
        onOutcomeDismissed={noop}
      />,
    )
    expect(document.activeElement).toBe(document.body)
  })
})
