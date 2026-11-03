import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ModelMenuItems } from './ModelMenuItems'
import type { ModelState } from '../api/types'

const model = (key: string, short = '', window = 0): ModelState => ({
  key,
  short,
  window,
  caps: { reasoning: false, images: false, parallelToolCalls: false },
})

// The grouped menu body both chat model menus render: a muted heading per
// provider, short labels with the full key as tooltip, loose models by full
// key, the current badge on the active or snapshot key, and the empty message.
describe('ModelMenuItems', () => {
  it('renders a heading before each provider group', () => {
    render(
      <ModelMenuItems
        models={[model('anthropic/sonnet', 'sonnet'), model('openai/gpt', 'gpt')]}
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    const groups = screen.getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['anthropic', 'openai'])
    expect(screen.getByText('sonnet')).toBeInTheDocument()
    expect(screen.getByText('gpt')).toBeInTheDocument()
  })

  it('lists loose models by full key without a heading', () => {
    render(
      <ModelMenuItems
        models={[model('local-tuned'), model('also-bare'), model('/slashed')]}
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'local-tuned',
      'also-bare',
      '/slashed',
    ])
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('falls back to the full key when a grouped model has no short', () => {
    render(
      <ModelMenuItems
        models={[model('anthropic/claude-x')]}
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    expect(screen.getByRole('menuitem', { name: 'anthropic/claude-x' })).toBeInTheDocument()
  })

  it('marks the active and snapshot keys as current', () => {
    render(
      <ModelMenuItems
        models={[model('a/one', 'one'), model('a/two', 'two'), model('b/three', 'three')]}
        active="a/one"
        currentKey="a/two"
        onPick={() => {}}
      />,
    )
    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => el.textContent?.replace(/\s*current$/, ''))).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(items.filter((el) => el.textContent?.includes('current'))).toHaveLength(2)
  })

  it('tooltips the full key and names the window when known', () => {
    render(
      <ModelMenuItems
        models={[model('a/big', 'big', 200_000), model('b/small', 'small', 0)]}
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    const big = screen.getByRole('menuitem', { name: 'big' })
    expect(big.getAttribute('title')).toContain('a/big')
    expect(big.getAttribute('title')).toContain('token window')
    expect(screen.getByRole('menuitem', { name: 'small' }).getAttribute('title')).toBe('b/small')
  })

  it('shows the empty message when nothing lists', () => {
    render(<ModelMenuItems models={[]} active="" currentKey="" onPick={() => {}} />)
    expect(screen.getByText('No models listed.')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('picks with the full key', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(
      <ModelMenuItems
        models={[model('anthropic/sonnet', 'sonnet'), model('local-tuned')]}
        active=""
        currentKey=""
        onPick={onPick}
      />,
    )
    await user.click(screen.getByRole('menuitem', { name: 'sonnet' }))
    await user.click(screen.getByRole('menuitem', { name: 'local-tuned' }))
    expect(onPick).toHaveBeenCalledWith('anthropic/sonnet')
    expect(onPick).toHaveBeenCalledWith('local-tuned')
  })
})
