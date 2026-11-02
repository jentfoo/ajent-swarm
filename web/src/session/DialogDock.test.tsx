import { render, screen, within } from '@testing-library/react'
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

function dock(dialogs: InteractionPending[], outcomes: DialogOutcome[] = []) {
  const onAnsweredLocally = vi.fn()
  render(
    <DialogDock
      sessionId="01S"
      dialogs={dialogs}
      outcomes={outcomes}
      onAnsweredLocally={onAnsweredLocally}
    />,
  )
  return { onAnsweredLocally }
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
    expect(screen.getByText(/Dialog 9 answered elsewhere — answered: option 2/)).toBeInTheDocument()

    const { unmount } = render(
      <DialogDock
        sessionId="01S"
        dialogs={[]}
        outcomes={[{ id: 10, answered: false, cancelled: true }]}
        onAnsweredLocally={() => {}}
      />,
    )
    expect(screen.getByText(/Dialog 10 answered elsewhere — cancelled/)).toBeInTheDocument()
    unmount()
  })

  it('lists several open dialogs oldest first', () => {
    dock([base({ id: 7, prompt: 'first question' }), base({ id: 8, prompt: 'second question' })])
    const first = screen.getByText('first question')
    const second = screen.getByText('second question')
    // document order is the oldest-first dock order
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
