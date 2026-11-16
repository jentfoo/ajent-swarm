import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConnectionBanner } from './ConnectionBanner'

// Copy maps each socket state one to one, first paint arrives connecting so
// the lost line stays reserved for a connection actually dropped.
describe('ConnectionBanner', () => {
  it('stays quiet while open', () => {
    const { container } = render(<ConnectionBanner connection="open" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('announces connecting while joining', () => {
    render(<ConnectionBanner connection="connecting" />)
    expect(screen.getByRole('status').textContent).toBe('Connecting to live updates…')
  })

  it('reports lost after a drop', () => {
    render(<ConnectionBanner connection="closed" />)
    expect(screen.getByRole('status').textContent).toBe('Live connection lost. Reconnecting…')
  })
})
