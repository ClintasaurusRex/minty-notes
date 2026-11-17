import { useRef } from 'react'

export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  return <dialog className="dialog shortcut-dialog" aria-labelledby="shortcuts-title" ref={(el) => { dialog.current = el; if (el && !el.open) el.showModal() }} onClose={onClose}>
    <h2 id="shortcuts-title">Keyboard shortcuts</h2>
    <dl className="keys">
      <dt>Alt+N</dt><dd>Quick capture in the Inbox</dd>
      <dt>Alt+\</dt><dd>Show or hide navigation</dd>
      <dt>Panel divider: ← / →</dt><dd>Resize (Shift for larger steps); Home / End for limits; Enter to collapse</dd>
      <dt>Project note grip: Alt+↑ / ↓</dt><dd>Move a note; selects Manual sorting</dd>
      <dt>Task card: Alt+arrows</dt><dd>Move between columns or reorder</dd>
      <dt>Ctrl/Cmd+Z / Shift+Z</dt><dd>Undo / redo</dd>
      <dt>Esc / Enter</dt><dd>Leave text and select its box / edit a selected box</dd>
      <dt>Object: arrows / Alt+arrows</dt><dd>Move / resize; Shift takes larger steps</dd>
      <dt>Ctrl/Cmd+D / Delete</dt><dd>Duplicate / remove selected object</dd>
      <dt>Alt+F10</dt><dd>Move from text to the toolbar; Esc returns</dd>
      <dt>[[ / Ctrl/Cmd+Shift+K</dt><dd>Link to a note; Alt+Enter follows its link</dd>
      <dt>Table: Tab / Shift+Tab</dt><dd>Next / previous cell</dd>
      <dt>Ctrl+Alt+C / Ctrl/Cmd+E</dt><dd>Code block / inline code</dd>
    </dl>
    <p className="muted small">More markup shortcuts are listed in Settings → Keyboard. Shortcuts pause while a dialog is open.</p>
    <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={() => dialog.current?.close()}>Close</button></div>
  </dialog>
}
