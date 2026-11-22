import { describe, expect, it } from 'vitest'

import { resetSessionDrag, sessionDrag, useSessionDrag } from './dndContext'
import { act, renderHook } from '@testing-library/react'

describe('sessionDrag store', () => {
  it('begins and ends the drag for every reader', () => {
    const { result } = renderHook(() => useSessionDrag())
    expect(result.current.dragging).toBeNull()

    act(() => sessionDrag.begin('01A'))
    expect(result.current.dragging).toBe('01A')

    act(() => sessionDrag.end())
    expect(result.current.dragging).toBeNull()
  })

  it('a fresh begin replaces the dragged session', () => {
    const { result } = renderHook(() => useSessionDrag())
    act(() => sessionDrag.begin('01A'))
    act(() => sessionDrag.begin('01B'))
    expect(result.current.dragging).toBe('01B')
    act(() => resetSessionDrag())
  })
})
