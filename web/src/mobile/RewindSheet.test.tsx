import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RewindSheet } from './RewindSheet'
import type { RewindCandidates } from '../api/types'

// The flat rewind list survives transport hiccups: a failed load's error must
// not outlive the sheet once a reload succeeds. Rows speak the shared rewind
// language — kind dot, label, relative age — with the head inert.

const listing: RewindCandidates = {
  head: '01C2',
  candidates: [
    { id: '01C1', kind: 'user', ts: 1000, isHead: false, text: 'first prompt' },
    { id: '01C2', kind: 'user', ts: 2000, isHead: true, text: 'current prompt' },
  ],
}

function renderSheet(open = true) {
  return render(
    <RewindSheet
      sessionId="01S"
      open={open}
      onClose={() => {}}
      onPrefill={() => {}}
      onToast={() => {}}
    />,
  )
}

describe('RewindSheet', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears a load error once a reload succeeds', async () => {
    let fail = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fail
          ? Response.json({ error: 'unavailable', message: 'candidates refused' }, { status: 503 })
          : Response.json(listing),
      ),
    )

    const { rerender } = renderSheet()
    expect(await screen.findByText(/candidates refused/)).toBeInTheDocument()

    // close, recover the transport, reopen: the old failure is gone
    fail = false
    rerender(
      <RewindSheet
        sessionId="01S"
        open={false}
        onClose={() => {}}
        onPrefill={() => {}}
        onToast={() => {}}
      />,
    )
    rerender(
      <RewindSheet
        sessionId="01S"
        open
        onClose={() => {}}
        onPrefill={() => {}}
        onToast={() => {}}
      />,
    )

    expect(await screen.findByText('first prompt')).toBeInTheDocument()
    expect(screen.queryByText(/candidates refused/)).not.toBeInTheDocument()
  })

  it('renders the shared row language with the head inert', async () => {
    const ago = (minutes: number): number => Date.now() - minutes * 60_000
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          head: '01C2',
          candidates: [
            {
              id: '01C1',
              kind: 'user',
              ts: ago(5),
              isHead: false,
              text: 'first prompt',
              truncated: true,
            },
            { id: '01C2', kind: 'user', ts: ago(1), isHead: true, text: 'current prompt' },
          ],
        }),
      ),
    )

    renderSheet()
    const head = await screen.findByTestId('rewind-01C2')
    expect(head).toBeDisabled()
    expect(within(head).getByText('current')).toBeInTheDocument()

    const row = screen.getByTestId('rewind-01C1')
    expect(row).toHaveTextContent('first prompt')
    expect(row).toHaveTextContent('5m ago')
    expect(row).toHaveTextContent('· truncated')
    expect(row.querySelector('.rewind-dot')).toBeInTheDocument()
  })
})
