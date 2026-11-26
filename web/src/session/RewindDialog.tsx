import type { ReactElement } from 'react'

import { ModalShell } from '../ui/ModalShell'
import { RewindList } from './RewindList'

// RewindDialog is the desktop chrome over the shared rewind picker: a centered
// modal running the keyboard cursor (arrows or j/k move, Enter rewinds, Esc
// closes through ModalShell) with a keep-current footer and a visible ✕ for
// pointer users. The candidate set, ordering and pick contract live in
// RewindList, shared with the phone sheet.
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
}): ReactElement {
  return (
    <ModalShell
      label="Rewind to an earlier point"
      className="rewind-modal"
      showClose
      onClose={onClose}
    >
      <h2 className="modal-title">Rewind</h2>
      <RewindList
        keyboard
        sessionId={sessionId}
        onClose={onClose}
        onToast={onToast}
        onPrefill={onPrefill}
      />
      <div className="rewind-foot">
        <span className="rewind-hint muted">↑↓ or j/k move · Enter rewinds · Esc closes</span>
        <button type="button" onClick={onClose}>
          Keep current history
        </button>
      </div>
    </ModalShell>
  )
}
