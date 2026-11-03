import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useNow } from './useNow'

// useNow under frozen timers: the snapshot starts honest and each interval
// tick replaces it, while the initial render needs no tick at all.

function Harness({ intervalMs }: { intervalMs: number }) {
  const now = useNow(intervalMs)
  return <span data-testid="now">{now}</span>
}

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the current clock without waiting for a tick', () => {
    vi.useFakeTimers()
    const start = Date.now()

    render(<Harness intervalMs={30_000} />)

    expect(screen.getByTestId('now')).toHaveTextContent(String(start))
  })

  it('re-snapshots on each interval', () => {
    vi.useFakeTimers()
    const start = Date.now()
    render(<Harness intervalMs={30_000} />)

    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByTestId('now')).toHaveTextContent(String(start + 30_000))

    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByTestId('now')).toHaveTextContent(String(start + 60_000))
  })
})
