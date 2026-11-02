import { useCallback, useEffect, useRef, useState } from 'react'
import type * as React from 'react'

import { ApiError } from '../api/client'
import { models as modelsAPI, sessions as sessionAPI } from '../api/endpoints'
import type { CtlState, ModelRow } from '../api/types'

// StatusHeader is the chrome above the transcript: model menu, permission
// mode chip with click cycling (shift-click walks back, mirroring Shift+Tab),
// context meter with compact-threshold coloring, turns and queue counts,
// running or idle state, interrupt while working. The spinner reconciles from
// snapshots only and never paints live.
export function StatusHeader({
  sessionId,
  snap,
  onToast,
  children,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
  children?: React.ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const working = snap.running || snap.spinning

  const interrupt = async () => {
    setBusy(true)
    try {
      await sessionAPI.interrupt(sessionId)
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Interrupt failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="session-header">
      <h1 style={{ margin: 0, fontSize: 'inherit' }}>{snap.session.name || snap.session.id}</h1>
      {working ? (
        <span className="badge accent" aria-label="running">
          running
        </span>
      ) : (
        snap.idle && <span className="badge">idle</span>
      )}
      {busy && <span className="badge warn">stopping…</span>}
      <ModeChip sessionId={sessionId} mode={snap.permission} onToast={onToast} />
      <ModelMenu
        sessionId={sessionId}
        current={snap.model.key}
        label={snap.model.short}
        onToast={onToast}
      />
      <ContextMeter snap={snap} />
      {snap.usage.turns > 0 && <UsageChip snap={snap} />}
      {snap.queued > 0 && <span className="badge">{snap.queued} queued</span>}
      {working && (
        <button type="button" onClick={() => void interrupt()} disabled={busy}>
          Interrupt
        </button>
      )}
      {children}
    </div>
  )
}

// ModeChip steps the permission mode through its cycle. There is no direct
// set method upstream: each step re-evaluates open approval dialogs, so the
// UI never walks multiple steps on one click.
function ModeChip({
  sessionId,
  mode,
  onToast,
}: {
  sessionId: string
  mode: string
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  if (mode === '') return null // no gate exists on this session
  const cycle = async (back: boolean) => {
    try {
      await sessionAPI.modeCycle(sessionId, back)
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Mode change refused.', 'error')
    }
  }
  return (
    <button
      type="button"
      className="badge mode-chip"
      title="Click to cycle forward, Shift+click backward"
      onClick={(ev) => void cycle(ev.shiftKey)}
    >
      mode: {mode}
    </button>
  )
}

// ContextMeter colors at the compact threshold: normal below it, warn as the
// window closes in on compaction and danger once the run crosses the line.
export function contextLevel(used: number, windowSize: number, compact: number): string {
  if (windowSize <= 0 || used <= 0) return ''
  if (compact > 0 && used >= compact * 0.9) return 'danger'
  if (compact > 0 && used >= compact * 0.7) return 'warn'
  const pct = (used / windowSize) * 100
  if (pct >= 90) return 'warn'
  return ''
}

function ContextMeter({ snap }: { snap: CtlState }) {
  const { used, window: win, compact } = snap.context
  if (win <= 0) return null
  const pct = Math.min(100, (used / win) * 100)
  const level = contextLevel(used, win, compact)
  return (
    <span
      className={`meter ${level}`}
      role="img"
      aria-label={`Context ${Math.round(pct)}% full`}
      title={`context ${used}/${win} tokens${compact > 0 ? `, compacts at ${compact}` : ''}`}
    >
      <div style={{ width: `${pct}%` }} />
    </span>
  )
}

// UsageChip expands into the poll-only totals, including the per-model
// breakdown; a resnapshot after each turn end and on the slow timer refreshes it.
function UsageChip({ snap }: { snap: CtlState }) {
  const [open, setOpen] = useState(false)
  const byModel = Object.entries(snap.usage.byModel ?? {})
  return (
    <>
      <button type="button" className="badge usage-chip" onClick={() => setOpen((v) => !v)}>
        {snap.usage.turns} turns
      </button>
      {open && (
        <div className="card usage-card" role="dialog" aria-label="Usage summary">
          <UsageTable label="total" u={snap.usage.total} />
          <UsageTable label="child" u={snap.usage.child} />
          {byModel.map(([key, u]) => (
            <UsageTable key={key} label={key} u={u} />
          ))}
        </div>
      )}
    </>
  )
}

function UsageTable({ label, u }: { label: string; u: CtlState['usage']['total'] }) {
  return (
    <table className="mono usage-table">
      <tbody>
        <tr>
          <th colSpan={2}>{label}</th>
        </tr>
        <tr>
          <td>input</td>
          <td>{u.input.toLocaleString()}</td>
        </tr>
        <tr>
          <td>output</td>
          <td>{u.output.toLocaleString()}</td>
        </tr>
        <tr>
          <td>cache read</td>
          <td>{u.cacheRead.toLocaleString()}</td>
        </tr>
        <tr>
          <td>reasoning</td>
          <td>{u.reasoning.toLocaleString()}</td>
        </tr>
      </tbody>
    </table>
  )
}

// ModelMenu rides ajent's own /model picker: discovery opens the dialog and
// returns its option keys, choosing one resolves it by index. Dismissing the
// menu cancels the picker so a given-up browse never strands the session.
function ModelMenu({
  sessionId,
  current,
  label,
  onToast,
}: {
  sessionId: string
  current: string // canonical key, what options compare against
  label: string // short display name for the closed chip
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState<ModelRow | null>(null)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const closeWithCleanup = useCallback(async () => {
    setOpen(false)
    const pickerId = row?.dialogId
    setRow(null)
    if (pickerId !== undefined && pickerId > 0) {
      try {
        await sessionAPI.resolve(sessionId, { dialogId: pickerId, cancel: true })
      } catch {
        // Already settled elsewhere is fine; nothing to report.
      }
    }
  }, [row?.dialogId, sessionId])

  useEffect(() => {
    if (!open) return
    const onDocClick = (ev: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) void closeWithCleanup()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open, closeWithCleanup])

  const openMenu = async () => {
    if (open) {
      await closeWithCleanup()
      return
    }
    setBusy(true)
    try {
      const rows = await modelsAPI.discover(sessionId)
      const found = rows[0] ?? null
      setRow(found)
      if (found === null) onToast('No model picker appeared.', 'error')
      else setOpen(true)
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Model discovery failed.', 'error')
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const pick = async (index: number) => {
    if (row?.dialogId === undefined) return
    try {
      await sessionAPI.resolve(sessionId, { dialogId: row.dialogId, index })
      setOpen(false)
      setRow(null)
    } catch (err) {
      // A settled picker means another surface answered it; that is benign.
      const settled = err instanceof ApiError && err.code === 'settled'
      if (!settled)
        onToast(err instanceof ApiError ? err.message : 'Model change refused.', 'error')
      void closeWithCleanup()
    }
  }

  return (
    <div ref={menuRef} className="model-menu">
      <button
        type="button"
        className="badge accent model-chip"
        disabled={busy}
        title="Switch model"
        onClick={() => void openMenu()}
      >
        {label || current || 'model'}
      </button>
      {open && row !== null && (
        <div className="menu card" role="menu">
          {(row.options ?? []).map((opt, i) => (
            <button key={i} type="button" role="menuitem" onClick={() => void pick(i)}>
              {opt}
              {opt === current && <span className="badge ok">current</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
