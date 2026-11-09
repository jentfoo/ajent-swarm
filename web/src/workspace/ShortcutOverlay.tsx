import { ModalShell } from '../ui/ModalShell'
import type { WorkspaceMode } from './layoutProfile'

const focusBindings: [string, string][] = [
  ['j / k', 'move through the queue'],
  ['Enter', 'open the highlighted row'],
  ['r', 'mark reviewed'],
  ['1 – 9', 'jump by position'],
  ['Esc', 'interrupt the stream, else focus the rail'],
  ['Esc ×2', 'while idle, open the rewind picker'],
  ['?', 'toggle this overlay'],
]

const tileBindings: [string, string][] = [
  ['Esc', "interrupt the focused pane's stream"],
  ['Esc ×2', 'while idle, open the rewind picker'],
  ['Mod+\\', 'split right'],
  ['Mod+Shift+\\', 'split down'],
  ['Mod+Arrows', 'move pane focus'],
  ['Alt+Arrows', 'resize'],
  ['1 – 9', 'jump to pane'],
  ['← / →', "walk a pane's tabs, Enter opens one"],
  ['drag', 'move tabs, drop on an edge to split'],
  ['?', 'toggle this overlay'],
]

// Dialog affordances shared by both modes: the ✕ every closable modal shows,
// and the digits a focused pane's head options card answers.
const dialogBindings: [string, string][] = [
  ['Esc / ✕', 'close a centered modal'],
  ['1 – 9', "answer the head dialog's option (focused pane)"],
]

// Composer bindings, shared by both modes: the session composer behaves the
// same in a focused pane or a tile. The arrows browse the recall list a
// Ctrl+R accept leaves behind. Alt+Up pops the newest queued prompt back for
// editing while composing, ajent's editor gesture.
const composerBindings: [string, string][] = [
  ['Ctrl+R', "search the viewed session's sent prompts"],
  ['↑ / ↓', 'after a search accept, recall older or newer'],
  ['Alt+↑', 'recall the newest queued prompt for editing'],
]

// BindingTable renders one shortcut list; the overlay shows the mode's own
// bindings, then the composer and dialog affordances both modes share.
function BindingTable({ bindings }: { bindings: [string, string][] }) {
  return (
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
  )
}

// ShortcutOverlay is the one keyboard map shared by both workspace modes; ?
// toggles it while Escape and clicks outside close it through ModalShell,
// which also holds the workspace's own bindings down while it shows. The ?
// press rides the shell's listener, so it answers only while this overlay is
// the topmost layer, never as a chord or a press claimed elsewhere.
export function ShortcutOverlay({ mode, onClose }: { mode: WorkspaceMode; onClose: () => void }) {
  const bindings = mode === 'tile' ? tileBindings : focusBindings
  return (
    <ModalShell
      label="Keyboard shortcuts"
      className="shortcut-card"
      onClose={onClose}
      onKey={(ev) => {
        if (ev.key === '?') onClose()
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>Keyboard shortcuts</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {mode === 'tile' ? 'Tile mode' : 'Focused mode'} · Mod is Ctrl or ⌘
      </p>
      <BindingTable bindings={bindings} />
      <h3>Prompt composer</h3>
      <BindingTable bindings={composerBindings} />
      <h3>Dialogs</h3>
      <BindingTable bindings={dialogBindings} />
    </ModalShell>
  )
}
