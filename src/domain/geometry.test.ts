import { describe, expect, it } from 'vitest'
import { clampRect, findFreeSpot, fitImageSize, fitScale, moveRect, pageHeight, PAGE_BOTTOM_ROOM, PAGE_MIN_HEIGHT, resizeRect } from './geometry'

const W = 1200

describe('page geometry', () => {
  it('keeps objects inside the page width and at nonnegative positions', () => {
    expect(clampRect({ x: -20, y: -5, w: 300, h: 100 }, W)).toEqual({ x: 0, y: 0, w: 300, h: 100 })
    expect(clampRect({ x: 1100, y: 10, w: 300, h: 100 }, W)).toEqual({ x: 900, y: 10, w: 300, h: 100 })
    // Wider than the page: shrinks to the page width rather than cropping.
    expect(clampRect({ x: 50, y: 0, w: 2000, h: 100 }, W)).toEqual({ x: 0, y: 0, w: 1200, h: 100 })
  })

  it('moves within bounds', () => {
    const start = { x: 100, y: 100, w: 200, h: 50 }
    expect(moveRect(start, 50, 25, W)).toEqual({ x: 150, y: 125, w: 200, h: 50 })
    expect(moveRect(start, -500, -500, W)).toEqual({ x: 0, y: 0, w: 200, h: 50 })
    expect(moveRect(start, 5000, 0, W).x).toBe(1000)
    // Pages grow downward: no upper limit on y.
    expect(moveRect(start, 0, 9000, W).y).toBe(9100)
  })

  it('resizes from each edge with the opposite edge anchored', () => {
    const start = { x: 100, y: 100, w: 200, h: 100 }
    const opts = { pageWidth: W, minW: 20, minH: 20, keepAspect: false }
    expect(resizeRect(start, 'e', 50, 0, opts)).toEqual({ x: 100, y: 100, w: 250, h: 100 })
    expect(resizeRect(start, 'w', 50, 0, opts)).toEqual({ x: 150, y: 100, w: 150, h: 100 })
    expect(resizeRect(start, 's', 0, 30, opts)).toEqual({ x: 100, y: 100, w: 200, h: 130 })
    expect(resizeRect(start, 'n', 0, 30, opts)).toEqual({ x: 100, y: 130, w: 200, h: 70 })
  })

  it('enforces minimum sizes and page edges while resizing', () => {
    const start = { x: 100, y: 100, w: 200, h: 100 }
    const opts = { pageWidth: W, minW: 80, minH: 20, keepAspect: false }
    expect(resizeRect(start, 'e', -500, 0, opts).w).toBe(80)
    expect(resizeRect(start, 'w', -500, 0, opts)).toMatchObject({ x: 0, w: 300 })
    expect(resizeRect(start, 'e', 5000, 0, opts)).toMatchObject({ x: 100, w: 1100 })
    expect(resizeRect(start, 'n', 0, -500, opts)).toMatchObject({ y: 0, h: 200 })
  })

  it('keeps the aspect ratio on image corner handles', () => {
    const start = { x: 100, y: 100, w: 400, h: 200 }
    const opts = { pageWidth: W, minW: 16, minH: 16, keepAspect: true }
    const r = resizeRect(start, 'se', 200, 10, opts)
    expect(r.w / r.h).toBeCloseTo(2, 1)
    expect(r).toMatchObject({ x: 100, y: 100, w: 600, h: 300 })
    const nw = resizeRect(start, 'nw', 100, 0, opts)
    expect(nw).toMatchObject({ x: 200, y: 150, w: 300, h: 150 })
    // Clamped at the right page edge without distorting.
    const big = resizeRect(start, 'se', 5000, 0, opts)
    expect(big.x + big.w).toBeLessThanOrEqual(W)
    expect(big.w / big.h).toBeCloseTo(2, 1)
  })

  it('grows the page height with content and always leaves room below', () => {
    expect(pageHeight([])).toBe(PAGE_MIN_HEIGHT)
    expect(pageHeight([{ x: 0, y: 3000, w: 10, h: 400 }])).toBe(3400 + PAGE_BOTTOM_ROOM)
  })

  it('places new objects below existing content instead of covering it', () => {
    const others = [
      { x: 40, y: 40, w: 400, h: 100 },
      { x: 40, y: 150, w: 400, h: 100 },
    ]
    const spot = findFreeSpot({ x: 40, y: 40, w: 300, h: 80 }, others, W, 16)
    expect(spot).toEqual({ x: 40, y: 266, w: 300, h: 80 })
    // A free area at the requested place is used as-is.
    expect(findFreeSpot({ x: 600, y: 40, w: 300, h: 80 }, others, W, 16)).toEqual({ x: 600, y: 40, w: 300, h: 80 })
  })

  it('sizes pasted screenshots in CSS pixels and fits them to the page', () => {
    expect(fitImageSize(800, 600, 2, 1104)).toEqual({ w: 400, h: 300 })
    expect(fitImageSize(3000, 1000, 1, 1104)).toEqual({ w: 1104, h: 368 })
    expect(fitImageSize(4, 4, 1, 1104)).toEqual({ w: 16, h: 16 })
  })

  it('fits the page to the available width without enlarging it', () => {
    expect(fitScale(1600, W)).toBe(1)
    expect(fitScale(600, W)).toBe(0.5)
    expect(fitScale(100, W)).toBe(0.25)
  })
})
