import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  clampCrop,
  defaultStrokeWidth,
  dragHandle,
  itemBounds,
  itemHandles,
  MARKUP_COLORS,
  moveItem,
  normalizeRect,
  resizeBy,
  roundMarkup,
  simplifyPoints,
  storedCrop,
  visibleRect,
  type MarkupHandle,
} from '../../domain/markup'
import { newId, type Annotation, type AnnotationKind, type Markup, type MarkupRect } from '../../domain/types'
import { saveBytesAsDownload } from '../../platform/download'
import { notify } from '../notices'
import { markedUpName, renderMarkupPng } from './markupExport'
import { measureLabel } from './markupHelpers'
import { MarkupSvg } from './MarkupSvg'

export type MarkupTool = 'select' | AnnotationKind | 'crop'

const TOOLS: { tool: MarkupTool; label: string; key: string; icon: string; imageOnly?: boolean }[] = [
  { tool: 'select', label: 'Select and move', key: 'V', icon: '↖' },
  { tool: 'arrow', label: 'Arrow', key: 'A', icon: '➚' },
  { tool: 'line', label: 'Line', key: 'L', icon: '╱' },
  { tool: 'rect', label: 'Rectangle', key: 'R', icon: '▭' },
  { tool: 'ellipse', label: 'Ellipse', key: 'E', icon: '◯' },
  { tool: 'text', label: 'Text label', key: 'T', icon: 'T' },
  { tool: 'pen', label: 'Pen', key: 'P', icon: '✎' },
  { tool: 'highlighter', label: 'Highlighter', key: 'H', icon: '▌' },
  { tool: 'blur', label: 'Blur (visual only)', key: 'B', icon: '◍', imageOnly: true },
  { tool: 'redact', label: 'Redact box', key: 'X', icon: '■', imageOnly: true },
  { tool: 'crop', label: 'Crop', key: 'C', icon: '⌗', imageOnly: true },
]

const KIND_NAMES: Record<AnnotationKind, string> = {
  arrow: 'Arrow',
  line: 'Line',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Label',
  pen: 'Pen stroke',
  highlighter: 'Highlight',
  blur: 'Blur area',
  redact: 'Redaction box',
}

const SIZES = [
  { id: 'S', label: 'Thin / small', factor: 0.6 },
  { id: 'M', label: 'Medium', factor: 1 },
  { id: 'L', label: 'Thick / large', factor: 1.8 },
] as const

const HINTS: Partial<Record<MarkupTool, string>> & { draw: string } = {
  select: 'Click an annotation to select it, drag to move it, or drag a handle to resize. Tab steps through annotations; arrow keys move them (Shift ×10), Alt+arrows resize; Delete removes.',
  blur: 'Blur is visual only. The original screenshot keeps every pixel (in this workspace and its backups), and blurred text can sometimes be read. Use a redaction box for passwords or personal data.',
  redact:
    'A redaction box covers the area here, but the original screenshot is still stored in this workspace and its backups. The covered pixels are only removed in a PNG copy made with “Save PNG copy”.',
  crop: 'Drag the frame or its corners to choose the visible part (arrow keys move it, Alt+arrows resize). The original image is kept; “Reset crop” shows all of it.',
  text: 'Click where the label should go and type. Enter finishes, Shift+Enter starts a new line, Esc cancels. Double-click a label to edit it.',
  draw: 'Drag to draw (Shift keeps lines straight and shapes square), or press Enter to add one in the middle and adjust it with the arrow keys.',
}

type Gesture =
  | { kind: 'draw'; start: { x: number; y: number } }
  | { kind: 'move'; start: { x: number; y: number }; before: Markup; item: Annotation; moved: boolean }
  | { kind: 'handle'; handle: MarkupHandle; before: Markup; item: Annotation }
  | { kind: 'crop-move'; start: { x: number; y: number }; crop: MarkupRect }
  | { kind: 'crop-handle'; handle: 'nw' | 'ne' | 'se' | 'sw'; crop: MarkupRect }
  | { kind: 'crop-draw'; start: { x: number; y: number } }

interface TextEdit {
  id: string | null
  x: number
  y: number
  value: string
  /** Where the input sits on screen (relative to the drawing area). */
  left: number
  top: number
}

interface Props {
  kind: 'image' | 'sketch'
  initial: Markup
  imageUrl: string | null
  /** Sketch background (also used for PNG copies of sketches). */
  background: string | null
  fileName: string
  getImage: () => Promise<Blob | null>
  idPrefix: string
  onDone: (markup: Markup) => void
  onCancel: () => void
}

function snapLine(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  const angle = Math.round(Math.atan2(y2 - y1, x2 - x1) / (Math.PI / 4)) * (Math.PI / 4)
  const len = Math.hypot(x2 - x1, y2 - y1)
  return { x: x1 + len * Math.cos(angle), y: y1 + len * Math.sin(angle) }
}

/**
 * Full-window editor for an image's markup or a sketch. Edits stay in this
 * dialog until Done, which saves them as one undoable page step.
 */
export function MarkupEditor({ kind, initial, imageUrl, background, fileName, getImage, idPrefix, onDone, onCancel }: Props) {
  const [markup, setMarkup] = useState<Markup>(initial)
  const [past, setPast] = useState<Markup[]>([])
  const [future, setFuture] = useState<Markup[]>([])
  const [tool, setTool] = useState<MarkupTool>(kind === 'sketch' ? 'pen' : 'arrow')
  const [color, setColor] = useState(kind === 'sketch' ? '#6ee7b7' : '#ef4444')
  const [size, setSize] = useState<(typeof SIZES)[number]['id']>('M')
  const [labelBackground, setLabelBackground] = useState(kind === 'image')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [cropDraft, setCropDraft] = useState<MarkupRect | null>(null)
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null)
  const [announce, setAnnounce] = useState('')
  const [busy, setBusy] = useState(false)
  const [stageBox, setStageBox] = useState({ w: 1, h: 1 })
  const dialog = useRef<HTMLDialogElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const textArea = useRef<HTMLTextAreaElement>(null)
  const headingId = useId()
  const hintId = useId()

  useEffect(() => {
    const d = dialog.current
    const returnTo = document.activeElement as HTMLElement | null
    if (d && !d.open) d.showModal()
    stage.current?.focus()
    return () => {
      if (d?.open) d.close()
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [])

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const update = () => setStageBox({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (textEdit) textArea.current?.focus()
  }, [textEdit])

  const cropping = tool === 'crop'
  const crop = cropDraft ?? markup.crop
  const view: MarkupRect = cropping ? { x: 0, y: 0, w: markup.width, h: markup.height } : visibleRect(markup)
  /** Markup units per screen pixel (the SVG keeps its aspect ratio inside the stage). */
  const unit = Math.max(view.w / stageBox.w, view.h / stageBox.h)
  const stroke = defaultStrokeWidth(markup) * SIZES.find((s) => s.id === size)!.factor
  const labelSize = Math.max(12, Math.round(Math.min(markup.width, markup.height) / 28)) * SIZES.find((s) => s.id === size)!.factor
  const selected = markup.items.find((a) => a.id === selectedId) ?? null
  const dirty = past.length > 0 || JSON.stringify(markup) !== JSON.stringify(initial)

  const commit = (next: Markup, before: Markup = markup) => {
    setPast((p) => [...p.slice(-199), before])
    setFuture([])
    setMarkup(next)
  }
  const replaceItem = (m: Markup, item: Annotation): Markup => ({ ...m, items: m.items.map((a) => (a.id === item.id ? item : a)) })
  const undo = () => {
    const prev = past[past.length - 1]
    if (!prev) return
    setPast(past.slice(0, -1))
    setFuture([markup, ...future])
    setMarkup(prev)
    if (selectedId && !prev.items.some((a) => a.id === selectedId)) setSelectedId(null)
    setAnnounce('Undone')
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setFuture(future.slice(1))
    setPast([...past, markup])
    setMarkup(next)
    setAnnounce('Redone')
  }

  const toPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = svg.current
    const ctm = el?.getScreenCTM()
    if (!el || !ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }
  const toScreen = (x: number, y: number): { left: number; top: number } => {
    const el = svg.current
    const ctm = el?.getScreenCTM()
    const box = stage.current?.getBoundingClientRect()
    if (!el || !ctm || !box) return { left: 0, top: 0 }
    const p = new DOMPoint(x, y).matrixTransform(ctm)
    return { left: p.x - box.left, top: p.y - box.top }
  }

  const describe = (a: Annotation) => {
    const b = itemBounds(a, measureLabel)
    return `${KIND_NAMES[a.kind]}${a.kind === 'text' ? ` “${a.text.slice(0, 40)}”` : ''}, ${Math.round(b.w)} by ${Math.round(b.h)}`
  }

  const newItem = (k: AnnotationKind, x: number, y: number): Annotation => {
    const id = newId()
    switch (k) {
      case 'arrow':
      case 'line':
        return { id, kind: k, x1: x, y1: y, x2: x, y2: y, color, width: stroke }
      case 'rect':
      case 'ellipse':
        return { id, kind: k, x, y, w: 0, h: 0, color, width: stroke, fill: null }
      case 'pen':
        return { id, kind: k, points: [x, y], color, width: stroke }
      case 'highlighter':
        return { id, kind: k, points: [x, y], color, width: stroke * 4 }
      case 'blur':
      case 'redact':
        return { id, kind: k, x, y, w: 0, h: 0 }
      case 'text':
        return { id, kind: k, x, y, text: '', color, size: labelSize, background: labelBackground ? (color === '#111111' ? '#ffffff' : '#111111') : null }
    }
  }

  const addItem = (item: Annotation) => {
    commit({ ...markup, items: [...markup.items, item] })
    setSelectedId(item.id)
    setAnnounce(`${describe(item)} added`)
  }

  const finishText = () => {
    const t = textEdit
    if (!t) return
    setTextEdit(null)
    const value = t.value.replace(/\s+$/, '')
    const existing = t.id ? markup.items.find((a) => a.id === t.id && a.kind === 'text') : undefined
    if (existing && existing.kind === 'text') {
      if (!value) {
        commit({ ...markup, items: markup.items.filter((a) => a.id !== existing.id) })
        setSelectedId(null)
        setAnnounce('Label removed')
      } else if (value !== existing.text) commit(replaceItem(markup, { ...existing, text: value }))
    } else if (value) {
      addItem({ ...(newItem('text', t.x, t.y) as Extract<Annotation, { kind: 'text' }>), text: value })
    }
    stage.current?.focus()
  }

  const editText = (a: Annotation) => {
    if (a.kind !== 'text') return
    setSelectedId(a.id)
    setTextEdit({ id: a.id, x: a.x, y: a.y, value: a.text, ...toScreen(a.x, a.y) })
  }

  const chooseTool = (t: MarkupTool) => {
    if (t === tool) return
    if (cropDraft) commitCrop(cropDraft)
    if (t === 'highlighter' && color === '#ef4444') setColor('#facc15')
    setTool(t)
    setDraft(null)
    if (t === 'crop') setSelectedId(null)
    setAnnounce(`${TOOLS.find((x) => x.tool === t)?.label} tool`)
  }

  const commitCrop = (c: MarkupRect | null) => {
    setCropDraft(null)
    const next = storedCrop(c, markup.width, markup.height)
    if (JSON.stringify(next) !== JSON.stringify(markup.crop)) commit({ ...markup, crop: next })
  }

  // ------------------------------------------------------------- pointer

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || textEdit) return
    const p = toPoint(e.clientX, e.clientY)
    const target = e.target as Element
    stage.current?.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    if (cropping) {
      const c = crop ?? { x: 0, y: 0, w: markup.width, h: markup.height }
      const h = target.closest('[data-crop-handle]')?.getAttribute('data-crop-handle') as 'nw' | 'ne' | 'se' | 'sw' | null
      if (h) gesture.current = { kind: 'crop-handle', handle: h, crop: c }
      else if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) gesture.current = { kind: 'crop-move', start: p, crop: c }
      else gesture.current = { kind: 'crop-draw', start: p }
      return
    }
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as MarkupHandle | null
    if (handle && selected) {
      gesture.current = { kind: 'handle', handle, before: markup, item: selected }
      return
    }
    if (tool === 'select') {
      const id = target.closest('[data-id]')?.getAttribute('data-id')
      const item = id ? markup.items.find((a) => a.id === id) : undefined
      if (item) {
        setSelectedId(item.id)
        setAnnounce(`${describe(item)} selected`)
        gesture.current = { kind: 'move', start: p, before: markup, item, moved: false }
      } else setSelectedId(null)
      return
    }
    if (tool === 'text') {
      const id = target.closest('[data-id]')?.getAttribute('data-id')
      const hit = id ? markup.items.find((a) => a.id === id && a.kind === 'text') : undefined
      if (hit) editText(hit)
      else setTextEdit({ id: null, x: p.x, y: p.y, value: '', ...toScreen(p.x, p.y) })
      e.preventDefault()
      return
    }
    setSelectedId(null)
    setDraft(newItem(tool, p.x, p.y))
    gesture.current = { kind: 'draw', start: p }
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current
    if (!g) return
    const p = toPoint(e.clientX, e.clientY)
    if (g.kind === 'draw' && draft) {
      if (draft.kind === 'arrow' || draft.kind === 'line') {
        const end = e.shiftKey ? snapLine(draft.x1, draft.y1, p.x, p.y) : p
        setDraft({ ...draft, x2: end.x, y2: end.y })
      } else if (draft.kind === 'pen' || draft.kind === 'highlighter') {
        const n = draft.points.length
        if (Math.hypot(p.x - draft.points[n - 2], p.y - draft.points[n - 1]) >= unit * 0.75) setDraft({ ...draft, points: [...draft.points, p.x, p.y] })
      } else if (draft.kind !== 'text') {
        let { x, y } = p
        if (e.shiftKey) {
          const side = Math.max(Math.abs(x - g.start.x), Math.abs(y - g.start.y))
          x = g.start.x + Math.sign(x - g.start.x || 1) * side
          y = g.start.y + Math.sign(y - g.start.y || 1) * side
        }
        setDraft({ ...draft, ...normalizeRect(g.start.x, g.start.y, x, y) })
      }
    } else if (g.kind === 'move') {
      const moved = moveItem(g.item, p.x - g.start.x, p.y - g.start.y)
      g.moved = true
      setMarkup(replaceItem(g.before, moved))
    } else if (g.kind === 'handle') {
      setMarkup(replaceItem(g.before, dragHandle(g.item, g.handle, p.x, p.y)))
    } else if (g.kind === 'crop-move') {
      setCropDraft(clampCrop({ ...g.crop, x: g.crop.x + p.x - g.start.x, y: g.crop.y + p.y - g.start.y }, markup.width, markup.height))
    } else if (g.kind === 'crop-handle') {
      const c = g.crop
      const fixed = { nw: [c.x + c.w, c.y + c.h], ne: [c.x, c.y + c.h], se: [c.x, c.y], sw: [c.x + c.w, c.y] }[g.handle]
      setCropDraft(clampCrop(normalizeRect(fixed[0], fixed[1], Math.min(Math.max(p.x, 0), markup.width), Math.min(Math.max(p.y, 0), markup.height)), markup.width, markup.height))
    } else if (g.kind === 'crop-draw') {
      setCropDraft(clampCrop(normalizeRect(g.start.x, g.start.y, Math.min(Math.max(p.x, 0), markup.width), Math.min(Math.max(p.y, 0), markup.height)), markup.width, markup.height))
    }
  }

  const onPointerUp = () => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (g.kind === 'draw' && draft) {
      setDraft(null)
      const b = itemBounds(draft)
      const tiny = Math.max(b.w, b.h) < unit * 4
      if (tiny && draft.kind !== 'pen' && draft.kind !== 'highlighter') return
      addItem(draft.kind === 'pen' || draft.kind === 'highlighter' ? { ...draft, points: simplifyPoints(draft.points, unit * 0.75) } : draft)
    } else if (g.kind === 'move' || g.kind === 'handle') {
      if (JSON.stringify(markup) !== JSON.stringify(g.before)) {
        setPast((p) => [...p.slice(-199), g.before])
        setFuture([])
        const now = markup.items.find((a) => a.id === g.item.id)
        if (now) setAnnounce(`${describe(now)}`)
      }
    } else if (g.kind === 'crop-move' || g.kind === 'crop-handle' || g.kind === 'crop-draw') {
      if (cropDraft) setAnnounce(`Crop ${Math.round(cropDraft.w)} by ${Math.round(cropDraft.h)}`)
    }
  }

  // ------------------------------------------------------------ keyboard

  const centerItem = (k: AnnotationKind): Annotation => {
    const cx = view.x + view.w / 2
    const cy = view.y + view.h / 2
    const s = Math.min(view.w, view.h) / 5
    const base = newItem(k, cx - s, cy - s / 2)
    switch (base.kind) {
      case 'arrow':
      case 'line':
        return { ...base, x1: cx - s, y1: cy - s / 2, x2: cx, y2: cy }
      case 'pen':
      case 'highlighter':
        return { ...base, points: [cx - s, cy, cx - s / 2, cy - s / 4, cx, cy, cx + s / 2, cy + s / 4] }
      case 'text':
        return base
      default:
        return { ...base, x: cx - s, y: cy - s / 2, w: s * 2, h: s }
    }
  }

  const onStageKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key
    if (mod && key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (mod && key.toLowerCase() === 'd' && selected) {
      e.preventDefault()
      addItem({ ...moveItem(selected, unit * 12, unit * 12), id: newId() })
      return
    }
    if (!mod && !e.altKey && key.length === 1) {
      const t = TOOLS.find((x) => x.key === key.toUpperCase() && (kind === 'image' || !x.imageOnly))
      if (t) {
        e.preventDefault()
        chooseTool(t.tool)
        return
      }
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const dir = arrows[key]
    if (dir) {
      const step = unit * (e.shiftKey ? 10 : 1)
      const [dx, dy] = [dir[0] * step, dir[1] * step]
      if (cropping) {
        e.preventDefault()
        const c = crop ?? { x: 0, y: 0, w: markup.width, h: markup.height }
        const next = clampCrop(e.altKey ? { ...c, w: c.w + dx, h: c.h + dy } : { ...c, x: c.x + dx, y: c.y + dy }, markup.width, markup.height)
        setCropDraft(next)
        setAnnounce(`Crop ${Math.round(next.w)} by ${Math.round(next.h)} at ${Math.round(next.x)}, ${Math.round(next.y)}`)
        return
      }
      if (!selected) return
      e.preventDefault()
      const next = e.altKey ? resizeBy(selected, dx, dy) : moveItem(selected, dx, dy)
      commit(replaceItem(markup, next))
      setAnnounce(describe(next))
      return
    }
    if ((key === 'Delete' || key === 'Backspace') && selected) {
      e.preventDefault()
      commit({ ...markup, items: markup.items.filter((a) => a.id !== selected.id) })
      setSelectedId(null)
      setAnnounce(`${KIND_NAMES[selected.kind]} deleted`)
      return
    }
    if (key === 'Tab' && !cropping && markup.items.length > 0) {
      const i = selected ? markup.items.indexOf(selected) : -1
      const next = e.shiftKey ? (i < 0 ? markup.items.length - 1 : i - 1) : i + 1
      if (next >= 0 && next < markup.items.length) {
        e.preventDefault()
        setSelectedId(markup.items[next].id)
        setAnnounce(`${describe(markup.items[next])} selected (${next + 1} of ${markup.items.length})`)
        return
      }
      setSelectedId(null)
      return
    }
    if (key === 'Enter') {
      e.preventDefault()
      if (selected?.kind === 'text') return editText(selected)
      if (tool === 'text') {
        const x = view.x + view.w / 3
        const y = view.y + view.h / 2
        return setTextEdit({ id: null, x, y, value: '', ...toScreen(x, y) })
      }
      if (tool !== 'select' && tool !== 'crop') addItem(centerItem(tool))
      return
    }
    if (key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (draft) setDraft(null)
      else if (cropDraft) setCropDraft(null)
      else if (selectedId) setSelectedId(null)
      else requestClose()
    }
  }

  const requestClose = () => {
    if (!dirty || window.confirm('Discard your markup changes?')) onCancel()
  }

  const done = () => {
    let final = markup
    if (cropDraft) final = { ...final, crop: storedCrop(cropDraft, final.width, final.height) }
    onDone(roundMarkup(final))
  }

  const applyStyle = (patch: { color?: string; size?: (typeof SIZES)[number]['id'] }) => {
    if (patch.color) setColor(patch.color)
    if (patch.size) setSize(patch.size)
    if (!selected) return
    const factor = SIZES.find((s) => s.id === (patch.size ?? size))!.factor
    let next: Annotation = selected
    if (patch.color && 'color' in next) next = { ...next, color: patch.color }
    if (patch.size) {
      if (next.kind === 'text') next = { ...next, size: Math.max(12, Math.round(Math.min(markup.width, markup.height) / 28)) * factor }
      else if (next.kind === 'highlighter') next = { ...next, width: defaultStrokeWidth(markup) * factor * 4 }
      else if ('width' in next) next = { ...next, width: defaultStrokeWidth(markup) * factor }
    }
    if (next !== selected) commit(replaceItem(markup, next))
  }

  const savePng = async () => {
    setBusy(true)
    try {
      const final = cropDraft ? { ...markup, crop: storedCrop(cropDraft, markup.width, markup.height) } : markup
      const blob = await renderMarkupPng(final, kind === 'image' ? await getImage() : null, background)
      saveBytesAsDownload(new Uint8Array(await blob.arrayBuffer()), markedUpName(fileName), 'image/png')
      notify('success', 'Saved a flattened PNG copy. Redacted areas are solid black in that file; the original stays unchanged in Minty Notes.')
    } catch (err) {
      notify('error', `The PNG copy could not be made: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------- render

  const handleSize = unit * 11
  const handles = selected && !cropping && !textEdit ? itemHandles(selected) : []
  const selBounds = selected && !cropping ? itemBounds(selected, measureLabel) : null
  const c = crop ?? { x: 0, y: 0, w: markup.width, h: markup.height }
  const hint = HINTS[tool] ?? HINTS.draw

  return (
    <dialog
      ref={dialog}
      className="dialog markup-editor"
      aria-labelledby={headingId}
      data-testid="markup-editor"
      onCancel={(e) => {
        e.preventDefault()
        if (!textEdit) requestClose()
      }}
    >
      <div className="markup-head">
        <h2 id={headingId}>{kind === 'image' ? 'Mark up image' : 'Sketch'}</h2>
        <div className="markup-tools" role="toolbar" aria-label="Markup tools">
          {TOOLS.filter((t) => kind === 'image' || !t.imageOnly).map((t) => (
            <button key={t.tool} type="button" className={`tool${tool === t.tool ? ' is-active' : ''}`} aria-pressed={tool === t.tool} title={`${t.label} (${t.key})`} aria-label={`${t.label} (${t.key})`} onClick={() => chooseTool(t.tool)}>
              <span aria-hidden="true">{t.icon}</span>
            </button>
          ))}
        </div>
        <div className="markup-tools" role="group" aria-label="Colour">
          {MARKUP_COLORS.map((c2) => (
            <button
              key={c2.value}
              type="button"
              className={`swatch${color === c2.value ? ' is-active' : ''}`}
              style={{ background: c2.value }}
              aria-pressed={color === c2.value}
              aria-label={c2.name}
              title={c2.name}
              onClick={() => applyStyle({ color: c2.value })}
            />
          ))}
        </div>
        <div className="markup-tools" role="group" aria-label="Line width and text size">
          {SIZES.map((s) => (
            <button key={s.id} type="button" className={`tool${size === s.id ? ' is-active' : ''}`} aria-pressed={size === s.id} aria-label={s.label} title={s.label} onClick={() => applyStyle({ size: s.id })}>
              {s.id}
            </button>
          ))}
          <label className="markup-check" title="Dark box behind new labels (easier to read on screenshots)">
            <input type="checkbox" checked={labelBackground} onChange={(e) => setLabelBackground(e.target.checked)} /> Label box
          </label>
        </div>
        <div className="markup-tools" role="group" aria-label="Edit">
          <button type="button" className="tool" disabled={past.length === 0} onClick={undo} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button type="button" className="tool" disabled={future.length === 0} onClick={redo} aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
          <button
            type="button"
            className="tool tool-wide"
            disabled={!selected}
            onClick={() => {
              if (!selected) return
              commit({ ...markup, items: markup.items.filter((a) => a.id !== selected.id) })
              setSelectedId(null)
            }}
          >
            Delete
          </button>
          {kind === 'image' && (
            <button type="button" className="tool tool-wide" disabled={!markup.crop && !cropDraft} onClick={() => commitCrop(null)}>
              Reset crop
            </button>
          )}
        </div>
      </div>
      <p className="markup-hint" id={hintId}>
        {hint}
      </p>
      <div
        ref={stage}
        className={`markup-stage${kind === 'sketch' ? ' is-sketch' : ''}`}
        tabIndex={0}
        role="application"
        aria-roledescription="drawing area"
        aria-label={`${kind === 'image' ? 'Image' : 'Sketch'} with ${markup.items.length} annotation${markup.items.length === 1 ? '' : 's'}. Tool keys: V select, A arrow, L line, R rectangle, E ellipse, T text, P pen, H highlighter${kind === 'image' ? ', B blur, X redact, C crop' : ''}. Enter adds, Tab selects, arrows move, Delete removes.`}
        aria-describedby={hintId}
        data-tool={tool}
        onKeyDown={onStageKeyDown}
      >
        <MarkupSvg
          markup={markup}
          imageUrl={imageUrl}
          idPrefix={`${idPrefix}-edit`}
          view={view}
          draft={draft}
          interactive
          hiddenId={textEdit?.id ?? null}
          className="markup-svg"
          svgRef={(el) => {
            svg.current = el
          }}
          preserveAspect
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={(e) => {
            const id = (e.target as Element).closest('[data-id]')?.getAttribute('data-id')
            const hit = id ? markup.items.find((a) => a.id === id) : undefined
            if (hit?.kind === 'text') editText(hit)
          }}
        >
          {kind === 'sketch' && (
            <>
              <defs>
                <pattern id={`${idPrefix}-grid`} width={20} height={20} patternUnits="userSpaceOnUse">
                  <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                </pattern>
              </defs>
              <rect x={0} y={0} width={markup.width} height={markup.height} fill={`url(#${idPrefix}-grid)`} pointerEvents="none" />
            </>
          )}
          {selBounds && <rect className="mk-selection" x={selBounds.x - unit * 4} y={selBounds.y - unit * 4} width={selBounds.w + unit * 8} height={selBounds.h + unit * 8} strokeWidth={unit * 1.5} strokeDasharray={`${unit * 5} ${unit * 4}`} />}
          {handles.map((h) => (
            <rect key={h.handle} className="mk-handle" data-handle={h.handle} x={h.x - handleSize / 2} y={h.y - handleSize / 2} width={handleSize} height={handleSize} strokeWidth={unit * 1.5} />
          ))}
          {cropping && (
            <>
              <path
                className="mk-crop-shade"
                fillRule="evenodd"
                d={`M0 0H${markup.width}V${markup.height}H0Z M${c.x} ${c.y}V${c.y + c.h}H${c.x + c.w}V${c.y}Z`}
              />
              <rect className="mk-crop" x={c.x} y={c.y} width={c.w} height={c.h} strokeWidth={unit * 2} />
              {(['nw', 'ne', 'se', 'sw'] as const).map((h) => {
                const hx = h.includes('w') ? c.x : c.x + c.w
                const hy = h.startsWith('n') ? c.y : c.y + c.h
                return <rect key={h} className="mk-handle" data-crop-handle={h} x={hx - handleSize / 1.4} y={hy - handleSize / 1.4} width={handleSize * 1.4} height={handleSize * 1.4} strokeWidth={unit * 1.5} />
              })}
            </>
          )}
        </MarkupSvg>
        {textEdit && (
          <textarea
            ref={textArea}
            className="markup-text-input"
            style={{ left: textEdit.left, top: textEdit.top, fontSize: Math.max(12, labelSize / unit), color }}
            value={textEdit.value}
            aria-label="Label text"
            rows={Math.max(1, textEdit.value.split('\n').length)}
            onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
            onBlur={finishText}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                finishText()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setTextEdit(null)
                stage.current?.focus()
              }
            }}
          />
        )}
      </div>
      <div className="markup-foot">
        <span className="sr-only" role="status" aria-live="polite">
          {announce}
        </span>
        <span className="muted small">
          {kind === 'image' ? 'The original image file is kept unchanged; annotations stay editable.' : 'Sketches stay editable.'} {markup.items.length} annotation{markup.items.length === 1 ? '' : 's'}.
        </span>
        <span className="btn-row">
          <button type="button" className="btn" disabled={busy} onClick={() => void savePng()} title="Download a flattened PNG: redacted areas are replaced with solid black, nothing outside the crop is kept">
            Save PNG copy
          </button>
          <button type="button" className="btn" onClick={requestClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={done} data-testid="markup-done">
            Done
          </button>
        </span>
      </div>
    </dialog>
  )
}
