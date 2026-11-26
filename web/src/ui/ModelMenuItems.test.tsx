import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ModelMenuItems } from './ModelMenuItems'
import type { ModelState } from '../api/types'

const model = (key: string, short = '', window = 0): ModelState => ({
  key,
  short,
  window,
  caps: { reasoning: false, images: false, parallelToolCalls: false },
})

const labels = () => screen.getAllByRole('menuitemradio').map((el) => el.textContent)

const registry = [
  model('anthropic/sonnet', 'sonnet'),
  model('anthropic/haiku', 'haiku'),
  model('openai/gpt', 'gpt'),
  model('local-tuned'),
]

// The grouped menu body both chat model menus render under their filter header:
// a muted heading per provider, short labels with the full key as tooltip, loose
// models by full key, the current badge and aria-checked on the active or
// snapshot key, and the empty messages. The query is the header's value.
describe('ModelMenuItems', () => {
  it('renders a heading before each provider group', () => {
    render(
      <ModelMenuItems
        models={[model('anthropic/sonnet', 'sonnet'), model('openai/gpt', 'gpt')]}
        query=""
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
        query=""
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    expect(labels()).toEqual(['local-tuned', 'also-bare', '/slashed'])
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('falls back to the full key when a grouped model has no short', () => {
    render(
      <ModelMenuItems
        models={[model('anthropic/claude-x')]}
        query=""
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    expect(screen.getByRole('menuitemradio', { name: 'anthropic/claude-x' })).toBeInTheDocument()
  })

  it('exposes every row as a radio, the current ones checked', () => {
    render(
      <ModelMenuItems
        models={[model('a/one', 'one'), model('a/two', 'two'), model('b/three', 'three')]}
        query=""
        active="a/one"
        currentKey="a/two"
        onPick={() => {}}
      />,
    )
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((el) => el.textContent?.replace(/\s*current$/, ''))).toEqual([
      'one',
      'two',
      'three',
    ])
    // the listing's active and the snapshot's key both read as current
    expect(screen.getAllByRole('menuitemradio', { checked: true })).toHaveLength(2)
    expect(screen.getByRole('menuitemradio', { name: /^one/ })).toBeChecked()
    expect(screen.getByRole('menuitemradio', { name: /^two/ })).toBeChecked()
    expect(screen.getByRole('menuitemradio', { name: 'three' })).not.toBeChecked()
    expect(screen.getAllByRole('menuitemradio', { checked: false })).toHaveLength(1)
    // the badge is the visual twin of the checked state, never its carrier
    expect(items.filter((el) => el.textContent?.includes('current'))).toHaveLength(2)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('tooltips the full key and names the window when known', () => {
    render(
      <ModelMenuItems
        models={[model('a/big', 'big', 200_000), model('b/small', 'small', 0)]}
        query=""
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    const big = screen.getByRole('menuitemradio', { name: 'big' })
    expect(big.getAttribute('title')).toContain('a/big')
    expect(big.getAttribute('title')).toContain('token window')
    expect(screen.getByRole('menuitemradio', { name: 'small' }).getAttribute('title')).toBe(
      'b/small',
    )
  })

  it('shows the empty message when nothing lists', () => {
    render(<ModelMenuItems models={[]} query="" active="" currentKey="" onPick={() => {}} />)
    expect(screen.getByText('No models listed.')).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
  })

  it('narrows the tree by the header query', () => {
    const view = render(
      <ModelMenuItems models={registry} query="" active="" currentKey="" onPick={() => {}} />,
    )
    expect(labels()).toEqual(['sonnet', 'haiku', 'gpt', 'local-tuned'])

    view.rerender(
      <ModelMenuItems models={registry} query="haiku" active="" currentKey="" onPick={() => {}} />,
    )
    expect(screen.queryByRole('group', { name: 'openai' })).not.toBeInTheDocument()
    expect(labels()).toEqual(['haiku'])

    // loosening the query brings the dropped groups back
    view.rerender(
      <ModelMenuItems models={registry} query="" active="" currentKey="" onPick={() => {}} />,
    )
    expect(labels()).toEqual(['sonnet', 'haiku', 'gpt', 'local-tuned'])
  })

  it('shows the distinct no-match message for a filter miss', () => {
    render(
      <ModelMenuItems
        models={[model('a/one', 'one')]}
        query="zzz"
        active=""
        currentKey=""
        onPick={() => {}}
      />,
    )
    expect(screen.getByText('No models match.')).toBeInTheDocument()
    expect(screen.queryByText('No models listed.')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
  })

  it('keeps the current row checked and badged while narrowed', () => {
    render(
      <ModelMenuItems
        models={[model('anthropic/sonnet', 'sonnet'), model('openai/gpt', 'gpt')]}
        query="sonnet"
        active="anthropic/sonnet"
        currentKey=""
        onPick={() => {}}
      />,
    )
    expect(labels()).toEqual(['sonnetcurrent'])
    expect(screen.getByRole('menuitemradio', { name: /^sonnet/ })).toBeChecked()
  })

  it('picks with the full key', async () => {
    const onPick = vi.fn()
    render(
      <ModelMenuItems
        models={[model('anthropic/sonnet', 'sonnet'), model('local-tuned')]}
        query=""
        active=""
        currentKey=""
        onPick={onPick}
      />,
    )
    screen.getByRole('menuitemradio', { name: /^sonnet/ }).click()
    screen.getByRole('menuitemradio', { name: 'local-tuned' }).click()
    expect(onPick).toHaveBeenCalledWith('anthropic/sonnet')
    expect(onPick).toHaveBeenCalledWith('local-tuned')
  })
})
