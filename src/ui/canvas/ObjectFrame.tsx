import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useServices } from '../../app/context'
import { MIN_IMAGE_SIZE, MIN_TEXT_WIDTH, clampRect, moveRect, resizeRect, type Handle } from '../../domain/geometry'
import type { CanvasObject } from '../../domain/types'
import { trackPointer } from '../gesture'
import { useCanvas } from './CanvasContext'

interface Props {
  obj: CanvasObject
  handles: Handle[]
  label: string
  /** Images move by dragging anywhere; text moves by its grip or border. */
  bodyDrag: boolean
  frameRef?: (el: HTMLDivElement | null) => void
  onEnter?: () => void
  children: ReactNode
}

/** Positioned container with selection outline, move/resize, and keyboard control. */
export function ObjectFrame({ obj, handles, label, bodyDrag, frameRef, onEnter, children }: Props) {
  const api = useCanvas()
  const { store } = useServices()
  const selected = api.selectedId === obj.id
  const isText = obj.type === 'text'

  const startMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || api.readOnly) return
    e.preventDefault()
    e.stopPropagation()
    const frame = (e.currentTarget.closest('.obj') as HTMLElement | null) ?? e.currentTarget
    api.select(obj.id)
    frame.focus({ preventScroll: true })
    const before = obj
    trackPointer(e, api.scale, api.scroller, {
      onMove: (dx, dy) => {
        const r = moveRect(before, dx, dy, api.pageWidth)
        store.previewObject(api.pageId, obj.id, { x: r.x, y: r.y })
      },
      onEnd: (moved) => {
        if (moved) store.commitGesture(api.pageId, 'Move', before)
      },
    })
  }

  const startResize = (handle: Handle) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || api.readOnly) return
    e.preventDefault()
    e.stopPropagation()
    const before = obj
    trackPointer(
      e,
      api.scale,
      api.scroller,
      {
        onMove: (dx, dy, ev) => {
          const r = resizeRect(before, handle, dx, dy, {
            pageWidth: api.pageWidth,
            minW: isText ? MIN_TEXT_WIDTH : MIN_IMAGE_SIZE,
            minH: isText ? 0 : MIN_IMAGE_SIZE,
            keepAspect: !isText && !ev.shiftKey,
          })
          store.previewObject(api.pageId, obj.id, isText ? { x: r.x, w: r.w } : r)
        },
        onEnd: (moved) => {
          if (moved) store.commitGesture(api.pageId, 'Resize', before)
        },
      },
      0,
    )
  }

  const onFramePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Text: only the frame's own border area moves it; the text itself stays editable.
    if (bodyDrag || e.target === e.currentTarget) startMove(e)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape') {
      e.preventDefault()
      api.select(null)
      api.focusPage()
      return
    }
    if (api.readOnly) return
    const step = e.shiftKey ? 10 : 1
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const dir = arrows[e.key]
    if (dir) {
      e.preventDefault()
      const [dx, dy] = dir
      if (e.altKey) {
        // Resize: right/left change width, down/up change height (images).
        const r = clampRect(
          { x: obj.x, y: obj.y, w: obj.w + dx * step, h: isText ? obj.h : obj.h + dy * step },
          api.pageWidth,
          isText ? MIN_TEXT_WIDTH : MIN_IMAGE_SIZE,
          isText ? 0 : MIN_IMAGE_SIZE,
        )
        store.updateObjects(api.pageId, [{ id: obj.id, patch: isText ? { w: r.w } : { w: r.w, h: r.h } }], 'Resize', `resize:${obj.id}`)
      } else {
        const r = moveRect(obj, dx * step, dy * step, api.pageWidth)
        store.updateObjects(api.pageId, [{ id: obj.id, patch: { x: r.x, y: r.y } }], 'Move', `nudge:${obj.id}`)
      }
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      api.remove(obj.id)
    } else if (e.key === 'Enter' && onEnter) {
      e.preventDefault()
      onEnter()
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      api.duplicate(obj.id)
    }
  }

  return (
    <div
      ref={frameRef}
      className={`obj obj-${obj.type}${selected ? ' is-selected' : ''}`}
      style={{ left: obj.x, top: obj.y, width: obj.w, height: isText ? undefined : obj.h, zIndex: obj.z }}
      tabIndex={0}
      role="group"
      aria-roledescription="movable object"
      aria-label={`${label}. Arrow keys move, Alt+arrow keys resize, Delete removes${onEnter ? ', Enter edits' : ''}.`}
      data-object-id={obj.id}
      onKeyDown={onKeyDown}
      onPointerDown={onFramePointerDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) api.select(obj.id)
      }}
    >
      {!bodyDrag && !api.readOnly && (
        <div className="obj-grip" onPointerDown={startMove} title="Drag to move" aria-hidden="true">
          <span />
        </div>
      )}
      {children}
      {selected &&
        !api.readOnly &&
        handles.map((h) => <div key={h} className={`obj-handle h-${h}`} onPointerDown={startResize(h)} aria-hidden="true" data-handle={h} />)}
    </div>
  )
}
