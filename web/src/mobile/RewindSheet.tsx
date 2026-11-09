import type { ReactElement } from 'react'

import { RewindList } from '../session/RewindList'
import { BottomSheet } from './BottomSheet'

// RewindSheet is the phone chrome over the shared rewind picker: a draggable
// bottom sheet, touch-driven, listing the same candidates in the same order as
// the desktop dialog with the same pick contract. The body lives in
// RewindList, theme CSS folds the tree chrome away and keeps the 44px rows.
export function RewindSheet({
  sessionId,
  open,
  onClose,
  onPrefill,
  onToast,
}: {
  sessionId: string
  open: boolean
  onClose: () => void
  onPrefill: (text: string) => void
  onToast: (text: string, level?: 'info' | 'error') => void
}): ReactElement | null {
  if (!open) return null
  return (
    <BottomSheet open onClose={onClose} label="Rewind">
      <RewindList sessionId={sessionId} onClose={onClose} onPrefill={onPrefill} onToast={onToast} />
    </BottomSheet>
  )
}
