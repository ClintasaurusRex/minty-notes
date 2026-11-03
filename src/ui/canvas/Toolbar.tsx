import { useEditorState, type Editor } from '@tiptap/react'
import { useState, type ReactNode } from 'react'
import { MIN_IMAGE_SIZE, MIN_TEXT_WIDTH, clampRect } from '../../domain/geometry'
import { pageLinkState } from '../../domain/pageLink'
import type { CanvasObject } from '../../domain/types'
import { useWorkspace } from '../../app/context'
import { IconBack, IconDuplicate, IconFront, IconImage, IconLink, IconPencil, IconRedo, IconText, IconTrash, IconUndo } from '../icons'
import { hasMarkup } from '../../domain/markup'
import { pageLinkAt, pageLinkRange } from './pageLinkUi'

interface Props {
  readOnly: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onAddText: () => void
  onAddImage: () => void
  onAddSketch: () => void
  /** Open the markup editor for the selected image or sketch. */
  onMarkup: () => void
  onSavePng: () => void
  editor: Editor | null
  selected: CanvasObject | null
  pageWidth: number
  onArrange: (patch: Partial<CanvasObject>) => void
  onFront: () => void
  onBack: () => void
  onDuplicate: () => void
  onDelete: () => void
  /** Open the page picker for the current text selection. */
  onPageLink: () => void
  onFollowLink: (pageId: string) => void
}

/** Toolbar buttons keep focus in the text being edited (mousedown is cancelled). */
export function ToolButton({ label, active, disabled, onClick, children, wide }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <button
      type="button"
      className={`tool${active ? ' is-active' : ''}${wide ? ' tool-wide' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function NumberField({ label, value, disabled, onCommit }: { label: string; value: number; disabled?: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Number(draft)
    setDraft(null)
    if (Number.isFinite(n) && n !== value) onCommit(n)
  }
  return (
    <label className="num-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={draft ?? Math.round(value)}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setDraft(null)
        }}
        aria-label={`${label} position or size in pixels`}
      />
    </label>
  )
}

function FormatTools({ editor, disabled, onPageLink }: { editor: Editor | null; disabled: boolean; onPageLink: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            underline: e.isActive('underline'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            codeBlock: e.isActive('codeBlock'),
            h1: e.isActive('heading', { level: 1 }),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            quote: e.isActive('blockquote'),
            table: e.isActive('table'),
            pageLink: !!pageLinkAt(e.state),
          }
        : null,
  })
  const off = disabled || !editor
  const run = (fn: (e: Editor) => void) => () => {
    if (editor) fn(editor)
  }
  return (
    <div className="tool-group" role="group" aria-label="Text formatting">
      <ToolButton label="Heading 1" active={s?.h1} disabled={off} onClick={run((e) => e.chain().focus().toggleHeading({ level: 1 }).run())}>
        H1
      </ToolButton>
      <ToolButton label="Heading 2" active={s?.h2} disabled={off} onClick={run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}>
        H2
      </ToolButton>
      <ToolButton label="Heading 3" active={s?.h3} disabled={off} onClick={run((e) => e.chain().focus().toggleHeading({ level: 3 }).run())}>
        H3
      </ToolButton>
      <span className="tool-sep" />
      <ToolButton label="Bold (Ctrl+B)" active={s?.bold} disabled={off} onClick={run((e) => e.chain().focus().toggleBold().run())}>
        <b>B</b>
      </ToolButton>
      <ToolButton label="Italic (Ctrl+I)" active={s?.italic} disabled={off} onClick={run((e) => e.chain().focus().toggleItalic().run())}>
        <i>I</i>
      </ToolButton>
      <ToolButton label="Underline (Ctrl+U)" active={s?.underline} disabled={off} onClick={run((e) => e.chain().focus().toggleUnderline().run())}>
        <u>U</u>
      </ToolButton>
      <ToolButton label="Strikethrough" active={s?.strike} disabled={off} onClick={run((e) => e.chain().focus().toggleStrike().run())}>
        <s>S</s>
      </ToolButton>
      <ToolButton label="Inline code (Ctrl+E)" active={s?.code} disabled={off} onClick={run((e) => e.chain().focus().toggleCode().run())}>
        <code>{'<>'}</code>
      </ToolButton>
      <ToolButton label="Code block (Ctrl+Alt+C)" active={s?.codeBlock} disabled={off} onClick={run((e) => e.chain().focus().toggleCodeBlock().run())}>
        <code>{'{ }'}</code>
      </ToolButton>
      <span className="tool-sep" />
      <ToolButton label="Bulleted list" active={s?.bullet} disabled={off} onClick={run((e) => e.chain().focus().toggleBulletList().run())}>
        •≡
      </ToolButton>
      <ToolButton label="Numbered list" active={s?.ordered} disabled={off} onClick={run((e) => e.chain().focus().toggleOrderedList().run())}>
        1≡
      </ToolButton>
      <ToolButton label="Quote" active={s?.quote} disabled={off} onClick={run((e) => e.chain().focus().toggleBlockquote().run())}>
        ❝
      </ToolButton>
      <ToolButton
        label="Insert table (3 × 3 with a header row)"
        active={s?.table}
        disabled={off || !!s?.table}
        onClick={run((e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      >
        ⊞
      </ToolButton>
      <ToolButton label="Link to a page (Ctrl+Shift+K, or type [[)" active={s?.pageLink} disabled={off} onClick={onPageLink}>
        <IconLink size={15} />
      </ToolButton>
      <ToolButton label="Clear formatting" disabled={off} onClick={run((e) => e.chain().focus().unsetAllMarks().clearNodes().run())}>
        T̸
      </ToolButton>
    </div>
  )
}

/** Row and column controls, shown while the cursor is in a table. */
function TableTools({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inTable: e.isActive('table'),
      canDeleteRow: e.can().deleteRow(),
      canDeleteCol: e.can().deleteColumn(),
      canMerge: e.can().mergeCells(),
      canSplit: e.can().splitCell(),
    }),
  })
  if (!s.inTable) return null
  const run = (fn: (e: Editor) => void) => () => fn(editor)
  return (
    <div className="tool-group table-tools" role="group" aria-label="Table rows and columns">
      <span className="tool-label">Table</span>
      <ToolButton label="Add row above" onClick={run((e) => e.chain().focus().addRowBefore().run())} wide>
        +Row ↑
      </ToolButton>
      <ToolButton label="Add row below" onClick={run((e) => e.chain().focus().addRowAfter().run())} wide>
        +Row ↓
      </ToolButton>
      <ToolButton label="Add column to the left" onClick={run((e) => e.chain().focus().addColumnBefore().run())} wide>
        +Col ←
      </ToolButton>
      <ToolButton label="Add column to the right" onClick={run((e) => e.chain().focus().addColumnAfter().run())} wide>
        +Col →
      </ToolButton>
      <ToolButton label="Delete row" disabled={!s.canDeleteRow} onClick={run((e) => e.chain().focus().deleteRow().run())} wide>
        −Row
      </ToolButton>
      <ToolButton label="Delete column" disabled={!s.canDeleteCol} onClick={run((e) => e.chain().focus().deleteColumn().run())} wide>
        −Col
      </ToolButton>
      <ToolButton label="Toggle header row" onClick={run((e) => e.chain().focus().toggleHeaderRow().run())} wide>
        Header
      </ToolButton>
      {(s.canMerge || s.canSplit) && (
        <ToolButton label={s.canMerge ? 'Merge selected cells' : 'Split cell'} onClick={run((e) => (s.canMerge ? e.chain().focus().mergeCells().run() : e.chain().focus().splitCell().run()))} wide>
          {s.canMerge ? 'Merge' : 'Split'}
        </ToolButton>
      )}
      <ToolButton label="Delete table" onClick={run((e) => e.chain().focus().deleteTable().run())} wide>
        −Table
      </ToolButton>
    </div>
  )
}

/** Open or remove the page link at the cursor. */
function LinkTools({ editor, readOnly, onFollow }: { editor: Editor; readOnly: boolean; onFollow: (pageId: string) => void }) {
  const pageId = useEditorState({ editor, selector: ({ editor: e }) => pageLinkAt(e.state) })
  const pages = useWorkspace((st) => st.data.pages)
  if (!pageId) return null
  const { state, title } = pageLinkState(pageId, pages)
  const name = state === 'missing' ? 'deleted page' : `“${title}”${state === 'trashed' ? ' (in Trash)' : ''}`
  return (
    <div className="tool-group link-tools" role="group" aria-label="Page link">
      <ToolButton label={`Open linked page ${name} (Alt+Enter)`} onClick={() => onFollow(pageId)} wide>
        <IconLink size={14} /> <span className="link-tools-name">Open {name}</span>
      </ToolButton>
      {!readOnly && (
        <ToolButton
          label="Remove page link (keeps the text)"
          onClick={() => {
            const range = pageLinkRange(editor.state)
            const chain = editor.chain().focus()
            if (range) chain.setTextSelection(range)
            chain.unsetMark('pageLink').run()
          }}
          wide
        >
          Unlink
        </ToolButton>
      )}
    </div>
  )
}

export function Toolbar(props: Props) {
  const { readOnly, selected, pageWidth } = props
  const isText = selected?.type === 'text'
  const arrange = (field: 'x' | 'y' | 'w' | 'h') => (v: number) => {
    if (!selected) return
    const r = clampRect({ x: selected.x, y: selected.y, w: selected.w, h: selected.h, [field]: v }, pageWidth, isText ? MIN_TEXT_WIDTH : MIN_IMAGE_SIZE, isText ? 0 : MIN_IMAGE_SIZE)
    props.onArrange(isText ? { x: r.x, y: r.y, w: r.w } : r)
  }
  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Page tools"
      onKeyDown={(e) => {
        // Esc returns from the toolbar to the text being edited (see Alt+F10).
        if (e.key === 'Escape' && isText && props.editor) {
          e.preventDefault()
          props.editor.commands.focus()
        }
      }}
    >
      <div className="tool-group">
        <ToolButton label="Undo (Ctrl+Z)" disabled={readOnly || !props.canUndo} onClick={props.onUndo}>
          <IconUndo />
        </ToolButton>
        <ToolButton label="Redo (Ctrl+Shift+Z)" disabled={readOnly || !props.canRedo} onClick={props.onRedo}>
          <IconRedo />
        </ToolButton>
      </div>
      <div className="tool-group">
        <ToolButton label="Add text box" disabled={readOnly} onClick={props.onAddText} wide>
          <IconText /> <span>Text</span>
        </ToolButton>
        <ToolButton label="Insert image from a file" disabled={readOnly} onClick={props.onAddImage} wide>
          <IconImage /> <span>Image</span>
        </ToolButton>
        <ToolButton label="Add a sketch (lines, arrows, shapes, labels, pen)" disabled={readOnly} onClick={props.onAddSketch} wide>
          <IconPencil /> <span>Sketch</span>
        </ToolButton>
      </div>
      <FormatTools editor={isText ? props.editor : null} disabled={readOnly} onPageLink={props.onPageLink} />
      {isText && props.editor && (
        // Floats over the top of the page so it never changes the toolbar's height
        // (a layout shift mid-click would turn a click into a drag selection).
        <div className="context-bar">
          {!readOnly && <TableTools editor={props.editor} />}
          <LinkTools editor={props.editor} readOnly={readOnly} onFollow={props.onFollowLink} />
        </div>
      )}
      {selected && selected.type !== 'text' && (
        <div className="context-bar">
          <div className="tool-group markup-context" role="group" aria-label={selected.type === 'sketch' ? 'Sketch' : 'Image markup'}>
            {!readOnly && (
              <ToolButton label={selected.type === 'sketch' ? 'Edit sketch (Enter or double-click)' : 'Mark up: arrows, shapes, labels, pen, highlighter, crop, blur, redact (Enter or double-click)'} onClick={props.onMarkup} wide>
                <IconPencil size={14} /> {selected.type === 'sketch' ? 'Edit sketch' : 'Mark up'}
              </ToolButton>
            )}
            {(selected.type === 'sketch' || hasMarkup(selected.markup)) && (
              <ToolButton label="Save a flattened PNG copy (redacted areas become solid black; the original is kept)" onClick={props.onSavePng} wide>
                Save PNG copy
              </ToolButton>
            )}
          </div>
        </div>
      )}
      {!readOnly && (
        // Always laid out (hidden while nothing is selected) so selecting an object
        // never changes the toolbar's height and shifts the page under the pointer.
        <div className={`tool-group arrange${selected ? '' : ' is-idle'}`} role="group" aria-label="Arrange selected object" aria-hidden={!selected} data-testid="arrange-tools">
          <NumberField key={`x-${selected?.id}`} label="X" value={selected?.x ?? 0} disabled={!selected} onCommit={arrange('x')} />
          <NumberField key={`y-${selected?.id}`} label="Y" value={selected?.y ?? 0} disabled={!selected} onCommit={arrange('y')} />
          <NumberField key={`w-${selected?.id}`} label="W" value={selected?.w ?? 0} disabled={!selected} onCommit={arrange('w')} />
          <NumberField key={`h-${selected?.id}`} label="H" value={selected?.h ?? 0} disabled={!selected || isText} onCommit={arrange('h')} />
          <ToolButton label="Bring to front" disabled={!selected} onClick={props.onFront}>
            <IconFront />
          </ToolButton>
          <ToolButton label="Send to back" disabled={!selected} onClick={props.onBack}>
            <IconBack />
          </ToolButton>
          <ToolButton label="Duplicate (Ctrl+D)" disabled={!selected} onClick={props.onDuplicate}>
            <IconDuplicate />
          </ToolButton>
          <ToolButton label="Delete object" disabled={!selected} onClick={props.onDelete}>
            <IconTrash />
          </ToolButton>
        </div>
      )}
    </div>
  )
}
