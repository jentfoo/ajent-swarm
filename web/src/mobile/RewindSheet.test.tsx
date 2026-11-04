import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RewindSheet } from './RewindSheet'
import type { RewindCandidates } from '../api/types'

// The flat rewind list survives transport hiccups: a failed load's error must
// not outlive the sheet once a reload succeeds.

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
})
