import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ModelSelectOptions } from './ModelSelectOptions'
import type { ModelState } from '../api/types'

const model = (key: string, short = ''): ModelState => ({
  key,
  short,
  window: 0,
  caps: { reasoning: false, images: false, parallelToolCalls: false },
})

// The shared select option body every model select renders: one optgroup per
// provider with short labels, loose models ungrouped by their full key.
describe('ModelSelectOptions', () => {
  it('groups options per provider with full-key values', () => {
    render(
      <select>
        <ModelSelectOptions
          models={[model('anthropic/sonnet', 'sonnet'), model('openai/gpt-5', 'gpt-5')]}
        />
      </select>,
    )
    const groups = screen.getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('label'))).toEqual(['anthropic', 'openai'])
    const options = screen.getAllByRole('option')
    expect(options.map((o) => `${o.textContent}:${o.getAttribute('value')}`)).toEqual([
      'sonnet:anthropic/sonnet',
      'gpt-5:openai/gpt-5',
    ])
  })

  it('lists loose models ungrouped by their full key', () => {
    render(
      <select>
        <ModelSelectOptions models={[model('local-tuned'), model('anthropic/sonnet', 'sonnet')]} />
      </select>,
    )
    const loose = screen
      .getAllByRole('option')
      .filter((o) => o.closest('optgroup') === null)
    expect(loose.map((o) => o.textContent)).toEqual(['local-tuned'])
  })
})
