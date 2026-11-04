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

  it('auto-dismisses answered-elsewhere chips after a few seconds', async () => {
    vi.useFakeTimers()
    try {
      const outcome = {
        id: 9,
        answered: true,
        cancelled: false,
        index: 0,
      } satisfies DialogOutcome
      render(
        <TouchDialogDock
          sessionId="01S"
          dialogs={[]}
          outcomes={[outcome]}
          onAnsweredLocally={() => {}}
        />,
      )

      expect(screen.getByText(/answered elsewhere/)).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(6_000)
      })
      expect(screen.queryByText(/answered elsewhere/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses answered-elsewhere chips on tap', async () => {
    const user = userEvent.setup()
    render(
      <TouchDialogDock
        sessionId="01S"
        dialogs={[]}
        outcomes={[{ id: 9, answered: false, cancelled: true }]}
        onAnsweredLocally={() => {}}
      />,
    )

    const chip = screen.getByText(/answered elsewhere/)
    await user.click(chip)
    expect(screen.queryByText(/answered elsewhere/)).not.toBeInTheDocument()
  })
})
