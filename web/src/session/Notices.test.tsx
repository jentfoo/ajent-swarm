import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Notices } from './Notices'
import type { NoticeView } from '../state/eventApplier'

// The shared transient notice lines: stale lines leave without a new event
// arriving, the newest three cap the stack, and the 1Hz timer runs only while
// a line is fresh.

function notice(text: string, level: NoticeView['level'] = 'info', ageMs = 0): NoticeView {
  return { key: '', text, level, at: Date.now() - ageMs }
}

describe('Notices', () => {
  it('renders nothing when every line arrived stale', () => {
    render(<Notices notices={[notice('long gone', 'info', 9_000)]} />)

    expect(screen.queryByLabelText('Notices')).not.toBeInTheDocument()
  })

  it('schedules no timer when every line is stale', () => {
    vi.useFakeTimers()
    try {
      render(<Notices notices={[notice('long gone', 'info', 9_000)]} />)

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires a fresh line once its TTL passes', () => {
    vi.useFakeTimers()
    try {
      render(<Notices notices={[notice('staged')]} />)
      expect(screen.getByText('staged')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(9_000)
      })
      expect(screen.queryByLabelText('Notices')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the timer once every line has expired', () => {
    vi.useFakeTimers()
    try {
      render(<Notices notices={[notice('staged')]} />)
      expect(vi.getTimerCount()).toBe(1)

      act(() => {
        vi.advanceTimersByTime(9_000)
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the timer when a new notice arrives', () => {
    vi.useFakeTimers()
    try {
      const view = render(<Notices notices={[notice('old', 'info', 9_000)]} />)
      expect(vi.getTimerCount()).toBe(0)

      view.rerender(<Notices notices={[notice('old', 'info', 9_000), notice('late')]} />)
      expect(screen.getByText('late')).toBeInTheDocument()
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps only the three freshest lines', () => {
    render(
      <Notices
        notices={[notice('one'), notice('two'), notice('three'), notice('four'), notice('five')]}
      />,
    )

    const wrap = screen.getByLabelText('Notices')
    expect(wrap.children).toHaveLength(3)
    expect(wrap).toHaveTextContent('three')
    expect(wrap).toHaveTextContent('four')
    expect(wrap).toHaveTextContent('five')
    expect(wrap).not.toHaveTextContent('one')
    expect(wrap).not.toHaveTextContent('two')
  })
})
