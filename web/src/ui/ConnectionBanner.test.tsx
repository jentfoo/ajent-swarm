import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConnectionBanner } from './ConnectionBanner'
import type { SocketState } from '../stream/swarmStream'

// The one live-update notice both shells render: quiet while the stream is
// open, one warn line while connecting or lost.

describe('ConnectionBanner', () => {
  it.each([
    ['open', null],
    ['connecting', 'Connecting to live updates…'],
    ['closed', 'Live connection lost. Reconnecting…'],
  ])('renders %s', (connection: string, text: string | null) => {
    render(<ConnectionBanner connection={connection as SocketState} />)
    if (text === null) expect(screen.queryByRole('status')).not.toBeInTheDocument()
    else expect(screen.getByRole('status')).toHaveTextContent(text)
  })

  it('always renders the warn variant when visible', () => {
    render(<ConnectionBanner connection="closed" />)
    expect(screen.getByRole('status')).toHaveClass('banner', 'warn')
  })
})
