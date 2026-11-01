import { useEditorState, type Editor } from '@tiptap/react'
import { useState, type ReactNode } from 'react'
import { MIN_IMAGE_SIZE, MIN_TEXT_WIDTH, clampRect } from '../../domain/geometry'
import type { CanvasObject } from '../../domain/types'
import { IconBack, IconDuplicate, IconFront, IconImage, IconRedo, IconText, IconTrash, IconUndo } from '../icons'

interface Props {
  readOnly: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onAddText: () => void
  onAddImage: () => void
  editor: Editor | null
  selected: CanvasObject | null
  pageWidth: number
  onArrange: (patch: Partial<CanvasObject>) => void
  onFront: () => void
  onBack: () => void
  onDuplicate: () => void
  onDelete: () => void
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

function FormatTools({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
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
            h1: e.isActive('heading', { level: 1 }),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            quote: e.isActive('blockquote'),
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
      <ToolButton label="Inline code" active={s?.code} disabled={off} onClick={run((e) => e.chain().focus().toggleCode().run())}>
        <code>{'<>'}</code>
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
      <ToolButton label="Clear formatting" disabled={off} onClick={run((e) => e.chain().focus().unsetAllMarks().clearNodes().run())}>
        T̸
      </ToolButton>
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
    <div className="toolbar" role="toolbar" aria-label="Page tools">
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
      </div>
      <FormatTools editor={isText ? props.editor : null} disabled={readOnly} />
      {selected && !readOnly && (
        <div className="tool-group arrange" role="group" aria-label="Arrange selected object">
          <NumberField key={`x-${selected.id}`} label="X" value={selected.x} onCommit={arrange('x')} />
          <NumberField key={`y-${selected.id}`} label="Y" value={selected.y} onCommit={arrange('y')} />
          <NumberField key={`w-${selected.id}`} label="W" value={selected.w} onCommit={arrange('w')} />
          <NumberField key={`h-${selected.id}`} label="H" value={selected.h} disabled={isText} onCommit={arrange('h')} />
          <ToolButton label="Bring to front" onClick={props.onFront}>
            <IconFront />
          </ToolButton>
          <ToolButton label="Send to back" onClick={props.onBack}>
            <IconBack />
          </ToolButton>
          <ToolButton label="Duplicate (Ctrl+D)" onClick={props.onDuplicate}>
            <IconDuplicate />
          </ToolButton>
          <ToolButton label="Delete object" onClick={props.onDelete}>
            <IconTrash />
          </ToolButton>
        </div>
      )}
    </div>
  )
}
