import { fireEvent, render, screen } from '@testing-library/react'
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

const labels = () => screen.getAllByRole('menuitem').map((el) => el.textContent)

// The grouped menu body both chat model menus render: a filter input above a
// muted heading per provider, short labels with the full key as tooltip, loose
// models by full key, the current badge on the active or snapshot key, and the
// empty messages. Escape in the filter clears the query before the overlay's
// own close can claim the press.
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
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('takes the caret on mount', () => {
    render(<ModelMenuItems models={[model('a/one')]} active="" currentKey="" onPick={() => {}} />)
    expect(screen.getByRole('searchbox')).toHaveFocus()
  })

  it('narrows the tree live as the query types', async () => {
    const user = userEvent.setup()
    render(
      <ModelMenuItems
        models={[
          model('anthropic/sonnet', 'sonnet'),
          model('anthropic/haiku', 'haiku'),
          model('openai/gpt', 'gpt'),
          model('local-tuned'),
        ]}
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    expect(labels()).toEqual(['sonnet', 'haiku', 'gpt', 'local-tuned'])

    const filter = screen.getByRole('searchbox')
    await user.type(filter, 'haiku')
    expect(screen.queryByRole('group', { name: 'openai' })).not.toBeInTheDocument()
    expect(labels()).toEqual(['haiku'])

    // loosening the query brings the dropped groups back
    await user.clear(filter)
    expect(labels()).toEqual(['sonnet', 'haiku', 'gpt', 'local-tuned'])
  })

  it('shows the distinct no-match message for a filter miss', async () => {
    const user = userEvent.setup()
    render(
      <ModelMenuItems models={[model('a/one', 'one')]} active="" currentKey="" onPick={() => {}} />,
    )

    await user.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByText('No models match.')).toBeInTheDocument()
    expect(screen.queryByText('No models listed.')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('keeps the current badge on the active row while narrowed', async () => {
    const user = userEvent.setup()
    render(
      <ModelMenuItems
        models={[model('anthropic/sonnet', 'sonnet'), model('openai/gpt', 'gpt')]}
        active="anthropic/sonnet"
        currentKey=""
        onPick={() => {}}
      />,
    )

    await user.type(screen.getByRole('searchbox'), 'sonnet')
    expect(labels()).toEqual(['sonnetcurrent'])
  })

  it('claims escape to clear the query before the layer close', async () => {
    const user = userEvent.setup()
    render(
      <ModelMenuItems
        models={[model('a/one', 'one'), model('b/two', 'two')]}
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    const filter = screen.getByRole('searchbox')
    // fireEvent answers whether the press was claimed, an empty query leaves
    // it for the popover's own Escape close
    expect(fireEvent.keyDown(filter, { key: 'Escape' })).toBe(true)

    await user.type(filter, 'zz')
    expect(fireEvent.keyDown(filter, { key: 'Escape' })).toBe(false)
    expect(filter).toHaveValue('')
    expect(labels()).toEqual(['one', 'two'])
  })

  it('clears a stale query when the listing empties', async () => {
    const user = userEvent.setup()
    const models = [model('a/one', 'one')]
    const view = render(
      <ModelMenuItems models={models} active="" currentKey="" onPick={() => {}} />,
    )

    await user.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByText('No models match.')).toBeInTheDocument()

    view.rerender(<ModelMenuItems models={[]} active="" currentKey="" onPick={() => {}} />)
    expect(screen.getByText('No models listed.')).toBeInTheDocument()
    expect(screen.queryByText('No models match.')).not.toBeInTheDocument()

    // the refill starts from an empty query, never the stale one
    view.rerender(<ModelMenuItems models={models} active="" currentKey="" onPick={() => {}} />)
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('menuitem', { name: 'one' })).toBeInTheDocument()
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
