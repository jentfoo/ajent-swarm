import { render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'

import {
  AttachIcon,
  BellIcon,
  BellOffIcon,
  ChainLinkIcon,
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  ExternalLinkIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PinIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from './icons'
import type { IconProps } from './icons'

// The one chrome icon set: every glyph renders as a decorative svg in the
// shared stroke dialect, carries no accessible name of its own (the host
// button labels), and passes size and className through.

const icons: Record<string, ComponentType<IconProps>> = {
  attach: AttachIcon,
  bell: BellIcon,
  'bell off': BellOffIcon,
  'chain link': ChainLinkIcon,
  check: CheckIcon,
  'chevron left': ChevronLeftIcon,
  close: CloseIcon,
  'external link': ExternalLinkIcon,
  moon: MoonIcon,
  'more horizontal': MoreHorizontalIcon,
  pin: PinIcon,
  search: SearchIcon,
  settings: SettingsIcon,
  sun: SunIcon,
}

describe('icons', () => {
  it.each(Object.entries(icons))('%s renders one decorative svg', (_name, Icon) => {
    const { container } = render(<Icon />)
    const svg = container.firstElementChild

    expect(svg).not.toBeNull()
    expect(svg!.tagName).toBe('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    // the host control carries the name, never the glyph
    expect(svg).not.toHaveAccessibleName()
  })

  it.each(Object.entries(icons))('%s shares one stroke dialect', (_name, Icon) => {
    const { container } = render(<Icon />)

    expect(container.firstElementChild).toHaveAttribute('viewBox', '0 0 24 24')
    expect(container.firstElementChild).toHaveAttribute('stroke-width', '2')
    expect(container.firstElementChild).toHaveAttribute('width', '16')
    expect(container.firstElementChild).toHaveAttribute('height', '16')
  })

  it('applies size and className overrides', () => {
    const { container } = render(<CheckIcon size={12} className="extra" />)
    const svg = container.firstElementChild

    expect(svg).toHaveAttribute('width', '12')
    expect(svg).toHaveAttribute('height', '12')
    expect(svg).toHaveClass('extra')
  })
})
