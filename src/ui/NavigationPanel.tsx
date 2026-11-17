import { useEffect, useRef, useState, type ReactNode } from 'react'

const MIN = 220
const MAX = 480
const DEFAULT = 264
function initialWidth(): number {
  try {
    const width = Number(localStorage.getItem('minty:navigation-width'))
    return Number.isFinite(width) && width >= MIN ? Math.min(MAX, width) : DEFAULT
  } catch { return DEFAULT }
}
function availableWidth(): number {
  return Math.min(MAX, window.innerWidth <= 760 ? window.innerWidth - 58 : window.innerWidth - 436)
}

/** Visual preferences are per device; resizing never writes workspace records. */
export function NavigationPanel({ children, onCollapse }: { children: ReactNode; onCollapse: () => void }) {
  const [width, setWidth] = useState(initialWidth)
  const [available, setAvailable] = useState(availableWidth)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointer: number; start: number; width: number } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const min = Math.min(MIN, available)
  const shown = Math.max(min, Math.min(width, available))
  const resize = (next: number) => {
    const value = Math.round(Math.max(min, Math.min(available, next)))
    setWidth(value)
    try { localStorage.setItem('minty:navigation-width', String(value)) } catch { /* optional */ }
  }
  useEffect(() => {
    const update = () => setAvailable(availableWidth())
    window.addEventListener('resize', update)
    // The overlay opens with its close control available to a keyboard user.
    if (window.innerWidth <= 760) close.current?.focus()
    return () => window.removeEventListener('resize', update)
  }, [])
  return <>
    <button className="navigation-backdrop" tabIndex={-1} aria-label="Close navigation" onClick={onCollapse} />
    <div id="navigation-panel" className={`navigation-panel${dragging ? ' is-resizing' : ''}`} ref={panel} style={{ width: shown }}
      onKeyDown={(event) => { if (window.innerWidth <= 760 && event.key === 'Escape' && !event.defaultPrevented && !(event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) { event.preventDefault(); onCollapse() } }}>
      <div className="navigation-controls">
        <button type="button" className="btn btn-small" ref={close} onClick={onCollapse} aria-label="Collapse navigation panel">‹ Collapse</button>
      </div>
      {children}
      <div role="separator" tabIndex={0} aria-label="Resize navigation panel" aria-orientation="vertical" aria-valuemin={min} aria-valuemax={available} aria-valuenow={shown}
        aria-valuetext={`${shown} pixels`} aria-controls="navigation-panel" aria-describedby="navigation-resize-help" className="navigation-resizer"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(shown + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10)) }
          if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); resize(event.key === 'Home' ? min : available) }
          if (event.key === 'Enter') { event.preventDefault(); onCollapse() }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointer: event.pointerId, start: event.clientX, width: shown }
          setDragging(true)
        }}
        onPointerMove={(event) => { if (drag.current?.pointer === event.pointerId) resize(drag.current.width + event.clientX - drag.current.start) }}
        onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId) } }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
        onPointerCancel={() => { drag.current = null; setDragging(false) }} />
      <span id="navigation-resize-help" className="sr-only">Left and right arrows resize; Shift takes larger steps. Home and End select minimum and maximum width. Enter collapses.</span>
    </div>
  </>
}
