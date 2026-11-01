export interface GestureHandlers {
  /** Pointer delta in page coordinates (already divided by the zoom scale). */
  onMove: (dx: number, dy: number, event: PointerEvent) => void
  onEnd: (moved: boolean, event: PointerEvent) => void
}

const AUTO_SCROLL_EDGE = 48
const AUTO_SCROLL_STEP = 18

/**
 * Track a pointer drag from a pointerdown. Movement below the threshold is
 * treated as a click. Scrolling during the drag (including auto-scroll near
 * the scroller's edges) is included in the delta, so objects follow the pointer.
 */
export function trackPointer(
  down: { clientX: number; clientY: number; pointerId: number; currentTarget: EventTarget | null },
  scale: number,
  scroller: HTMLElement | null,
  handlers: GestureHandlers,
  threshold = 3,
): void {
  const target = down.currentTarget as HTMLElement
  const startX = down.clientX
  const startY = down.clientY
  const startScrollTop = scroller?.scrollTop ?? 0
  const startScrollLeft = scroller?.scrollLeft ?? 0
  let moved = false
  try {
    target.setPointerCapture(down.pointerId)
  } catch {
    // Synthetic events in tests may not support capture.
  }

  const delta = (ev: PointerEvent) => ({
    dx: (ev.clientX - startX + (scroller ? scroller.scrollLeft - startScrollLeft : 0)) / scale,
    dy: (ev.clientY - startY + (scroller ? scroller.scrollTop - startScrollTop : 0)) / scale,
  })

  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < threshold) return
    moved = true
    if (scroller) {
      const r = scroller.getBoundingClientRect()
      if (ev.clientY > r.bottom - AUTO_SCROLL_EDGE) scroller.scrollTop += AUTO_SCROLL_STEP
      else if (ev.clientY < r.top + AUTO_SCROLL_EDGE) scroller.scrollTop -= AUTO_SCROLL_STEP
    }
    const { dx, dy } = delta(ev)
    handlers.onMove(dx, dy, ev)
  }
  const end = (ev: PointerEvent) => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', end)
    target.removeEventListener('pointercancel', end)
    handlers.onEnd(moved, ev)
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', end)
  target.addEventListener('pointercancel', end)
}
