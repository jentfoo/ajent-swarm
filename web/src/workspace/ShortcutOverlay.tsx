import { useEffect } from 'react'

import type { WorkspaceMode } from './layoutProfile'

const inboxBindings: [string, string][] = [
  ['j / k', 'move through the queue'],
  ['Enter', 'open the highlighted row'],
  ['r', 'mark reviewed'],
  ['1 – 9', 'jump by position'],
  ['Esc', 'return focus to the rail'],
  ['?', 'toggle this overlay'],
]

const tileBindings: [string, string][] = [
  ['Mod+W', 'close the focused pane'],
  ['Mod+\\', 'split right'],
  ['Mod+Shift+\\', 'split down'],
  ['Mod+Arrows', 'move pane focus'],
  ['Alt+Arrows', 'resize'],
  ['1 – 9', 'jump to pane'],
  ['drag', 'move tabs, drop on an edge to split'],
  ['?', 'toggle this overlay'],
]

// ShortcutOverlay is the one keyboard map shared by both workspace modes; ?
// toggles it, Escape or a click outside closes it.
export function ShortcutOverlay({ mode, onClose }: { mode: WorkspaceMode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' || ev.key === '?') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const bindings = mode === 'tile' ? tileBindings : inboxBindings
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card shortcut-card"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>Keyboard shortcuts</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {mode === 'tile' ? 'Tile mode' : 'Inbox mode'} · Mod is Ctrl or ⌘
        </p>
        <table className="shortcut-table">
          <tbody>
            {bindings.map(([keys, what]) => (
              <tr key={keys}>
                <td className="mono">{keys}</td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
