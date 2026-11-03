import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatusBadge } from './StatusBadge'

// One component owns the badge copy and classes, so the headers and the
// switcher rows cannot drift apart.

describe('StatusBadge', () => {
  it('renders the danger states', () => {
    for (const status of ['input', 'ended'] as const) {
      const { unmount } = render(<StatusBadge status={status} />)
      const badge = screen.getByText(status === 'input' ? 'needs input' : 'ended')
      expect(badge).toHaveClass('badge', 'danger')
      unmount()
    }
  })

  it('renders the running accent', () => {
    render(<StatusBadge status="running" />)

    expect(screen.getByText('running')).toHaveClass('badge', 'accent')
  })

  it('renders the resting states plain', () => {
    for (const status of ['waiting', 'idle'] as const) {
      const { unmount } = render(<StatusBadge status={status} />)
      expect(screen.getByText(status).className).toBe('badge')
      unmount()
    }
  })
})
