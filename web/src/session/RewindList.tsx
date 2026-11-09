import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import type { RewindCandidate } from '../api/types'
import { absoluteTime, kindClass, kindLabel, relativeTime } from './rewind'

// RewindList is the one rewind picker body behind both chromes: the desktop
// dialog's modal and the phone's bottom sheet. Candidates load per mount,
// every kind lists in the server's tree order with no cap, and one pick
// rewinds, toasts success, prefills a prompt for an edit (warning first when
// its text arrived truncated) and closes. `keyboard` runs the desktop cursor:
// arrows or j/k move it, Enter picks beneath it, sheets stay touch-driven.
export function RewindList({
  sessionId,
  keyboard = false,
  onClose,
  onPrefill,
  onToast,
}: {
  sessionId: string
  keyboard?: boolean
  onClose: () => void
  onPrefill: (text: string) => void
  onToast: (text: string, level?: 'info' | 'error') => void
}): ReactElement {
  const [candidates, setCandidates] = useState<RewindCandidate[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [cursorId, setCursorId] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // one load per mount: a reopen refetches instead of showing stale forks
  useEffect(() => {
    let alive = true
    sessionAPI
      .candidates(sessionId)
      .then((res) => {
        if (alive) setCandidates(res.candidates)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(describeError(err, 'Loading rewind points failed.'))
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  // every listed row rewinds somewhere except the head, which only marks where
  // the session stands now
  const rows = candidates ?? []
  const pickable = rows.filter((c) => !c.isHead)
  // the cursor opens beside the head, ajent's picker spot
  const at = pickable.findIndex((c) => c.id === cursorId)
  const cursorIndex = at >= 0 ? at : pickable.length - 1
  const cursor = pickable[cursorIndex]?.id ?? ''

  const pick = async (c: RewindCandidate) => {
    if (busyId !== '' || c.isHead) return
    setBusyId(c.id)
    try {
      await sessionAPI.rewind(sessionId, c.id)
      onToast(`Rewound onto ${kindLabel(c.kind)}.`, 'info')
      const text = c.text ?? ''
      if (text !== '') {
        // the truncation warning lands before the prefill it explains
        if (c.truncated) onToast('The prompt was too large to prefill in full.', 'error')
        onPrefill(text) // a rewound prompt opens for editing
      }
      onClose()
    } catch (err) {
      onToast(describeError(err, 'Rewind refused.'), 'error')
    } finally {
      setBusyId('')
    }
  }

  // rebinds per render so the handler always reads the live cursor
  useEffect(() => {
    if (!keyboard) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.key === 'ArrowDown' || ev.key === 'j') {
        ev.preventDefault()
        setCursorId(pickable[Math.min(cursorIndex + 1, pickable.length - 1)]?.id ?? '')
      } else if (ev.key === 'ArrowUp' || ev.key === 'k') {
        ev.preventDefault()
        setCursorId(pickable[Math.max(cursorIndex - 1, 0)]?.id ?? '')
      } else if (ev.key === 'Enter') {
        // a focused control answers its own Enter, e.g. the footer button
        const owns =
          ev.target instanceof HTMLElement &&
          ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(ev.target.tagName)
        const row = pickable[cursorIndex]
        if (!owns && row !== undefined) {
          ev.preventDefault()
          void pick(row)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // keep the keyboard cursor visible while it moves, like the focus rail
  useEffect(() => {
    if (!keyboard) return
    listRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor, keyboard])

  return (
    <div className="rewind-list" ref={listRef}>
      {candidates === null && !loadError && <p className="muted">Loading rewind points…</p>}
      {loadError && <p className="error-text">{loadError}</p>}
      {candidates !== null && rows.length === 0 && !loadError && (
        <p className="muted">Nothing rewirable yet: no prompts, replies or compactions.</p>
      )}
      {rows.map((c) => (
        <div
          key={c.id}
          role="button"
          tabIndex={-1}
          aria-disabled={c.isHead || busyId !== '' || undefined}
          data-cursor={keyboard && c.id === cursor ? true : undefined}
          data-testid={`rewind-${c.id}`}
          className={`rewind-row ${c.isHead ? 'head' : ''} ${c.active ? '' : 'off'}`}
          title={`${kindLabel(c.kind)} · ${c.isHead ? 'current head' : absoluteTime(c.ts)}`}
          onClick={() => void pick(c)}
        >
          <span className="rewind-guide" aria-hidden="true">
            {c.guide ?? ''}
          </span>
          <span className={`rewind-tag ${kindClass(c.kind)}`}>{kindLabel(c.kind)}</span>
          <span className={`rewind-dot ${kindClass(c.kind)}`} aria-hidden="true" />
          <span className="rewind-label">{c.label || c.id}</span>
          <span className="rewind-detail">
            {c.isHead ? 'current' : relativeTime(c.ts)}
            {c.truncated ? ' · truncated' : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
