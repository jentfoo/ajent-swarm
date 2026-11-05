import { useEffect } from 'react'

import { ModalShell } from '../ui/ModalShell'
import type { WorkspaceMode } from './layoutProfile'

const focusBindings: [string, string][] = [
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
// toggles it while Escape and clicks outside close it through ModalShell,
// which also holds the workspace's own bindings down while it shows.
export function ShortcutOverlay({ mode, onClose }: { mode: WorkspaceMode; onClose: () => void }) {
  // '?' reaches this listener even though workspace keys rest behind the shell
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === '?') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const bindings = mode === 'tile' ? tileBindings : focusBindings
  return (
    <ModalShell label="Keyboard shortcuts" className="shortcut-card" onClose={onClose}>
      <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>Keyboard shortcuts</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {mode === 'tile' ? 'Tile mode' : 'Focused mode'} · Mod is Ctrl or ⌘
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
    </ModalShell>
  )
}
