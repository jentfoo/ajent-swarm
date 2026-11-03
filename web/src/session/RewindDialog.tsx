import { useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { RewindCandidate } from '../api/types'
import { ModalShell } from '../ui/ModalShell'
import { absoluteTime, kindClass, kindLabel, relativeTime } from './rewind'

// RewindDialog offers the fork candidates GET /candidates derived: user prompts
// re-send (their text prefills the composer for an edit), assistant replies and
// compaction targets are allowed, and everything else never lists. Rows mirror
// ajent's TUI picker — guide connectors, kind tag, label, relative age in one
// grid row — and run keyboard-first: arrows or j/k move the cursor, Enter
// rewinds, Esc closes through ModalShell. The head row stays visible but inert,
// so the picker's primary action never lands as a silent no-op; a refusal
// surfaces as a toast and the picker stays open.
export function RewindDialog({
  sessionId,
  onClose,
  onToast,
  onPrefill,
}: {
  sessionId: string
  onClose: () => void
  onToast: (text: string, level?: 'info' | 'error') => void
  onPrefill: (text: string) => void
}) {
  const [candidates, setCandidates] = useState<RewindCandidate[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [cursorId, setCursorId] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    sessionAPI
      .candidates(sessionId)
      .then((res) => {
        if (alive) setCandidates(res.candidates)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(err instanceof ApiError ? err.message : 'Loading candidates failed.')
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

  const rewind = async (c: RewindCandidate) => {
    if (busyId !== '' || c.isHead) return
    setBusyId(c.id)
    try {
      await sessionAPI.rewind(sessionId, c.id)
      onToast(`Rewound onto ${kindLabel(c.kind)}.`, 'info')
      if (c.text !== undefined && c.text !== '') {
        onPrefill(c.text) // rewinding a prompt opens it for editing
        if (c.truncated) onToast('The prompt was too large to prefill in full.', 'error')
      }
      onClose()
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Rewind refused.', 'error')
    } finally {
      setBusyId('')
    }
  }

  // rebinds per render so the handler always reads the live cursor; a focused
  // control keeps its own Enter, so the footer button answers itself
  useEffect(() => {
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
          void rewind(row)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // keep the keyboard cursor visible while it moves, like the focus rail
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  return (
    <ModalShell label="Rewind to an earlier point" className="rewind-modal" onClose={onClose}>
      <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>Rewind</h2>
      {candidates === null && !loadError && <p className="muted">Loading forks…</p>}
      {loadError && <p className="error-text">{loadError}</p>}
      {candidates !== null && candidates.length === 0 && (
        <p className="muted">Nothing rewirable yet: no prompts, replies or compactions.</p>
      )}
      <div className="rewind-list" ref={listRef}>
        {rows.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={-1}
            aria-disabled={c.isHead || busyId !== '' || undefined}
            data-cursor={c.id === cursor || undefined}
            className={`rewind-row ${c.isHead ? 'head' : ''} ${c.active ? '' : 'off'}`}
            title={`${kindLabel(c.kind)} · ${c.isHead ? 'current head' : absoluteTime(c.ts)}`}
            onClick={() => void rewind(c)}
          >
            <span className="rewind-guide" aria-hidden="true">
              {c.guide ?? ''}
            </span>
            <span className={`rewind-tag ${kindClass(c.kind)}`}>{kindLabel(c.kind)}</span>
            <span className="rewind-label">{c.label || c.id}</span>
            <span className="rewind-detail">{c.isHead ? 'current' : relativeTime(c.ts)}</span>
          </div>
        ))}
      </div>
      <div className="rewind-foot">
        <span className="rewind-hint muted">↑↓ or j/k move · Enter rewinds · Esc closes</span>
        <button type="button" onClick={onClose}>
          Keep current history
        </button>
      </div>
    </ModalShell>
  )
}
