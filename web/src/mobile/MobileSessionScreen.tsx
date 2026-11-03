import { useCallback, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { sessions as sessionAPI } from '../api/endpoints'
import { Composer } from '../session/Composer'
import { TranscriptView } from '../session/TranscriptView'
import { useKeyboardInset } from '../hooks/useKeyboardInset'
import { useSessionChannel } from '../hooks/useSessionChannel'
import { useWorkspace } from '../providers/workspace'
import { BottomSheet } from './BottomSheet'
import { ModelChip } from './ModelChip'
import { RewindSheet } from './RewindSheet'
import { StatusStrip } from './StatusStrip'
import { SwitcherRows } from './SwitcherRows'
import { ToolsSheet } from './ToolsSheet'
import { TouchDialogDock } from './TouchDialogDock'
import { useSwitcherRows } from './useSwitcherRows'

// edgeSwipePx is how far right a touch starting in the left edge zone must
// travel to reopen the switcher sheet.
const edgeSwipePx = 56

interface Toast {
  id: number
  text: string
  level: 'info' | 'error'
}

// MobileSessionScreen drives one session on a phone. The component tree stays
// shared with desktop (TranscriptView, Composer); only the chrome forks: a
// sticky compact header collapsing to model plus spinner, dialogs as stacked
// full-width cards above the composer, and a status strip where side rails
// used to be.
export default function MobileSessionScreen(): ReactElement {
  const { sessionId = '' } = useParams()
  const { state, phase, loadOlder, dispatch } = useSessionChannel(sessionId)
  const { acknowledgeDialog, acknowledgeTurn } = useWorkspace()
  const snap = state.snapshot

  const [draft, setDraft] = useState('')
  const [showTools, setShowTools] = useState(false)
  const [showRewind, setShowRewind] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const keyboardInset = useKeyboardInset()

  // Edge-swipe from the left reopens the switcher over any session view; the
  // touch zone is only the first 24px so transcript selection never fights it.
  const edgeStartX = useRef<number | null>(null)

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastID = useRef(0)
  const pushToast = useCallback((text: string, level: 'info' | 'error' = 'info') => {
    const id = ++toastID.current
    setToasts((ts) => [...ts.slice(-4), { id, text, level }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6_000)
  }, [])

  const dialogs = snap.interactions ?? []
  const composerDisabled = phase !== 'live' || dialogs.length > 0
  const disabledReason =
    dialogs.length > 0
      ? 'A dialog needs an answer before prompts can send.'
      : 'The session is not reachable right now.'

  return (
    <div
      className="session-screen mobile-session"
      style={keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
      onTouchStart={(ev) => {
        edgeStartX.current = ev.touches[0]?.clientX ?? null
      }}
      onTouchEnd={(ev) => {
        const start = edgeStartX.current
        edgeStartX.current = null
        if (start === null || start > 24 || showRewind || showTools) return
        const dx = (ev.changedTouches[0]?.clientX ?? 0) - start
        if (dx >= edgeSwipePx) setSheetOpen(true)
      }}
    >
      <header className="mobile-session-header">
        <Link to="/" aria-label="Back to launcher" className="back-link">
          ←
        </Link>
        <ModelChip sessionId={sessionId} snap={snap} onToast={pushToast} />
        {phase !== 'live' && phase !== 'ended' && (
          <span className={`badge ${phase === 'resyncing' ? 'warn' : ''}`}>{phase}</span>
        )}
        <span className="spacer" />
        <SeatClaim sessionId={sessionId} held={!snap.seat.yours} holder={snap.seat.holder} />
        <button type="button" onClick={() => setShowRewind(true)}>
          Rewind
        </button>
        <button type="button" onClick={() => setShowTools(true)} aria-label="Open tools panel">
          Tools
        </button>
      </header>

      {phase === 'ended' && (
        <div className="banner warn" role="status">
          Session ended.{' '}
          <Link to={`/m/read/${encodeURIComponent(sessionId)}`}>Read the transcript</Link> or resume
          from the launcher.
        </div>
      )}
      {phase !== 'live' && phase !== 'ended' && (
        <div className="banner info" role="status">
          Returning to the app will refresh what you see here.
        </div>
      )}

      <TranscriptView state={state} loadOlder={loadOlder} pullDownToLatest />

      <StatusStrip snap={snap} />
      <TouchDialogDock
        sessionId={sessionId}
        dialogs={dialogs}
        outcomes={state.resolvedElsewhere}
        onAnsweredLocally={(dialogId) => {
          dispatch({ type: 'dialogAnswered', dialogId })
          acknowledgeDialog(sessionId, dialogId)
        }}
      />
      <Composer
        sessionId={sessionId}
        value={draft}
        onChange={setDraft}
        disabled={composerDisabled}
        disabledReason={disabledReason}
        onSubmit={(line, pendingId) => {
          dispatch({ type: 'pendingSubmitted', pendingId, text: line })
          acknowledgeTurn(sessionId, Date.now())
        }}
        onSubmitFailed={(pendingId) => dispatch({ type: 'pendingFailed', pendingId })}
      />

      <ToolsSheet
        sessionId={sessionId}
        snap={snap}
        open={showTools}
        onClose={() => setShowTools(false)}
        onToast={pushToast}
      />
      <RewindSheet
        sessionId={sessionId}
        open={showRewind}
        onClose={() => setShowRewind(false)}
        onPrefill={setDraft}
        onToast={pushToast}
      />

      {/* the switcher rides over any session view, reopened by edge swipe */}
      <SwitcherOverlay open={sheetOpen} onClose={() => setSheetOpen(false)} />

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

// SwitcherOverlay is the same bottom sheet the home screen shows, fed by the
// same shared row model so a dialog waiting anywhere is visible before
// switching.
function SwitcherOverlay({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const navigate = useNavigate()
  const rows = useSwitcherRows()

  return (
    <BottomSheet open={open} onClose={onClose} label="Session switcher">
      <SwitcherRows
        rows={rows}
        onOpen={(row) => {
          onClose()
          if (row.status === 'ended') navigate(`/m/read/${encodeURIComponent(row.sessionId)}`)
          else navigate(`/s/${encodeURIComponent(row.sessionId)}`)
        }}
      />
    </BottomSheet>
  )
}

// SeatClaim is the compact seat affordance: hidden while this connection
// already holds or shares the write seat, a takeover button when someone else
// owns it.
function SeatClaim({
  sessionId,
  held,
  holder,
}: {
  sessionId: string
  held: boolean
  holder?: string
}): ReactElement | null {
  const [busy, setBusy] = useState(false)
  if (!held) return null

  const takeControl = async () => {
    setBusy(true)
    try {
      await sessionAPI.takeControl(sessionId)
    } catch {
      // Refusals keep their holder name; the next snapshot updates the badge.
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="badge warn seat-claim"
      onClick={() => void takeControl()}
      disabled={busy}
    >
      {holder ? `seat: ${holder}` : 'seat held'}
    </button>
  )
}
