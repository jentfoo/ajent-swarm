import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TouchDialogDock } from './TouchDialogDock'
import type { DialogOutcome } from '../state/eventApplier'
import type { InteractionPending } from '../api/types'

// Touch dialog presentation: stacked full-width cards with separate large
// buttons, a dedicated secret screen with show and hide, and answered-
// elsewhere chips that auto-dismiss instead of parking.

const approve = {
  id: 42,
  kind: 'pick',
  prompt: 'Allow write access to src/?',
  options: ['permit', 'deny'],
} satisfies InteractionPending

describe('TouchDialogDock', () => {
  it('answers option dialogs with one tap per button, never a compact row', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      Response.json({ settled: false }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const answered = vi.fn()

    render(
      <TouchDialogDock
        sessionId="01S"
        dialogs={[approve]}
        outcomes={[]}
        onAnsweredLocally={answered}
        onOutcomeDismissed={() => {}}
      />,
    )

    // permit and deny are separate buttons, each answering its own index
    const buttons = screen.getAllByRole('button', { name: /permit|deny/ })
    expect(buttons).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'deny' }))

    await vi.waitFor(() => {
      const resolveCalls = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/resolve'))
      expect(resolveCalls).toHaveLength(1)
      expect(JSON.parse(String(resolveCalls[0]![1]?.body))).toEqual({ dialogId: 42, index: 1 })
    })
  })

  it('keeps secret dialogs on a dedicated screen with show and hide', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ settled: false })),
    )

    render(
      <TouchDialogDock
        sessionId="01S"
        dialogs={[{ id: 7, kind: 'secret', prompt: 'API key?', text: true, secret: true }]}
        outcomes={[]}
        onAnsweredLocally={() => {}}
        onOutcomeDismissed={() => {}}
      />,
    )

    const input = screen.getByLabelText('Secret answer')
    expect(input).toHaveAttribute('type', 'password')
    // mobile keeps autofocus: only one session is ever visible here
    expect(input).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(input).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(input).toHaveAttribute('type', 'password')
  })

  it('dismisses answered-elsewhere chips through the store, not just the view', async () => {
    vi.useFakeTimers()
    try {
      const outcome = {
        id: 9,
        answered: true,
        cancelled: false,
        index: 0,
      } satisfies DialogOutcome
      const onOutcomeDismissed = vi.fn()
      render(
        <TouchDialogDock
          sessionId="01S"
          dialogs={[]}
          outcomes={[outcome]}
          onAnsweredLocally={() => {}}
          onOutcomeDismissed={onOutcomeDismissed}
        />,
      )

      // the chip reads its detail inline and leaves the store once expired,
      // so it cannot reappear on remount
      expect(screen.getByText(/answered elsewhere/)).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(6_000)
      })
      expect(onOutcomeDismissed).toHaveBeenCalledWith(9)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses answered-elsewhere chips on tap', async () => {
    const user = userEvent.setup()
    const onOutcomeDismissed = vi.fn()
    render(
      <TouchDialogDock
        sessionId="01S"
        dialogs={[]}
        outcomes={[{ id: 9, answered: false, cancelled: true }]}
        onAnsweredLocally={() => {}}
        onOutcomeDismissed={onOutcomeDismissed}
      />,
    )

    await user.click(screen.getByText(/answered elsewhere/))
    expect(onOutcomeDismissed).toHaveBeenCalledWith(9)
  })
})

// Permit note flow on touch: the optional note rides the tap that picks Deny
// or Allow with note, and the barrier's follow-up ask auto-resolves from that
// intent without ever rendering. Without an intent the ask renders by hand.
describe('TouchDialogDock permit note flow', () => {
  const permitDialog: InteractionPending = {
    id: 7,
    kind: 'decision',
    prompt: 'Allow write access to src/?',
    options: ['Allow', 'Allow with note', 'Deny'],
  }

  const followUpAsk = (prompt: string): InteractionPending => ({
    id: 8,
    kind: 'ask',
    prompt,
    text: true,
  })

  function permitDock(dialogs: InteractionPending[]) {
    const bodies: Record<string, unknown>[] = []
    const fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return Response.json({ settled: false })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const answered = vi.fn()
    const view = render(
      <TouchDialogDock
        sessionId="01S"
        dialogs={dialogs}
        outcomes={[]}
        onAnsweredLocally={answered}
        onOutcomeDismissed={() => {}}
      />,
    )
    const rerenderWith = (next: InteractionPending[]) =>
      view.rerender(
        <TouchDialogDock
          sessionId="01S"
          dialogs={next}
          outcomes={[]}
          onAnsweredLocally={answered}
          onOutcomeDismissed={() => {}}
        />,
      )
    return { answered, bodies, rerenderWith }
  }

  const noteInput = () => screen.getByPlaceholderText('Note for the agent (optional)')

  it('deny with empty note cancels the follow-up ask', async () => {
    const user = userEvent.setup()
    const { answered, bodies, rerenderWith } = permitDock([permitDialog])
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 2 })

    // the follow-up ask arrives and the pending empty intent cancels it blind
    rerenderWith([followUpAsk('reason for denying')])
    await vi.waitFor(() => {
      expect(bodies[1]).toEqual({ dialogId: 8, cancel: true })
      expect(answered).toHaveBeenCalledWith(8)
    })
    // suppressed while the auto-answer round trip lands, so nothing flashes
    expect(screen.queryByText('reason for denying')).not.toBeInTheDocument()
  })

  it('deny with typed note submits the reason', async () => {
    const user = userEvent.setup()
    const { bodies, rerenderWith } = permitDock([permitDialog])
    await user.type(noteInput(), 'not without a review')
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 2 })

    rerenderWith([followUpAsk('reason for denying')])
    await vi.waitFor(() => expect(bodies[1]).toEqual({ dialogId: 8, text: 'not without a review' }))
    expect(screen.queryByText('reason for denying')).not.toBeInTheDocument()
  })

  it('allow with note mirrors deny on empty input', async () => {
    const user = userEvent.setup()
    const { bodies, rerenderWith } = permitDock([permitDialog])
    await user.click(screen.getByRole('button', { name: 'Allow with note' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 1 })

    rerenderWith([followUpAsk('note for allowing')])
    await vi.waitFor(() => expect(bodies[1]).toEqual({ dialogId: 8, cancel: true }))
    expect(screen.queryByText('note for allowing')).not.toBeInTheDocument()
  })

  it('allow with note mirrors deny on typed input', async () => {
    const user = userEvent.setup()
    const { bodies, rerenderWith } = permitDock([permitDialog])
    await user.type(noteInput(), 'staging only')
    await user.click(screen.getByRole('button', { name: 'Allow with note' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 1 })

    rerenderWith([followUpAsk('note for allowing')])
    await vi.waitFor(() => expect(bodies[1]).toEqual({ dialogId: 8, text: 'staging only' }))
    expect(screen.queryByText('note for allowing')).not.toBeInTheDocument()
  })

  it('plain allow never creates an intent', async () => {
    const user = userEvent.setup()
    const { bodies, rerenderWith } = permitDock([permitDialog])
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(bodies[0]).toEqual({ dialogId: 7, index: 0 })

    rerenderWith([followUpAsk('note for allowing')])
    await act(async () => {}) // flush any wrongly scheduled auto-answer
    expect(bodies).toHaveLength(1)
    // no intent pending: the ask renders for hand answering
    expect(screen.getByText('note for allowing')).toBeInTheDocument()
  })
})
