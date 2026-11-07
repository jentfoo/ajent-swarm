import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LiveStreamBlock } from './LiveStreamBlock'
import type { LiveTurn } from '../state/eventApplier'

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => cb(0))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

describe('dbg', () => {
  it('shows DOM', () => {
    const live: LiveTurn = {
      model: 'sonnet',
      thinking: '',
      thinkingOpen: false,
      text: '',
      textOpen: false,
      tools: [{ id: 'p1', name: 'agent_poll', outputs: [] }],
    }
    const { container } = render(
      <LiveStreamBlock live={live} activity={[{ key: 'sub-2', text: 'x', rank: 0 }]} />,
    )
    console.log('DOM:' + container.innerHTML)
    expect(document.querySelectorAll('[data-tool-id]')).toHaveLength(1)
  })
})
