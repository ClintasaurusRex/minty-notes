import { generateHTML } from '@tiptap/core'
import { richTextExtensions } from '../domain/richtext'
import type { CanvasObject, ImageObject, SketchObject, TextObject } from '../domain/types'
import { pushDown } from './layoutRules'
import type { Interval, TextLine } from './paginate'

/**
 * Measures a note for PDF export using the browser's own layout. Each text box
 * is rendered off-screen with the editor's CSS at its real width, then every
 * word's position, every background and border, list markers, decorations,
 * and links are read back in canvas coordinates. The PDF therefore has the
 * same line breaks as the page on screen; only the glyph outlines come from
 * the embedded fonts. (DOM only; the rules it uses are pure.)
 */

export type FontKey = 'sans' | 'sans-b' | 'sans-i' | 'sans-bi' | 'mono' | 'mono-b' | 'mono-i' | 'mono-bi'

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0–1 */
  a: number
}

export interface LaidWord {
  /** The word without invisible format characters (what the PDF text contains). */
  text: string
  /** The word as written (for drawing it as a picture with the browser's shaping). */
  raw: string
  x: number
  w: number
  /** Whitespace before the word on the same line. */
  before?: string
}

export interface LaidDecoration {
  x1: number
  x2: number
  y: number
  width: number
  color: Rgba
  dotted: boolean
}

export interface LaidRun extends Interval {
  font: FontKey
  /** CSS font of the text (to draw characters the embedded font lacks as pictures). */
  cssFont: string
  size: number
  color: Rgba
  baseline: number
  words: LaidWord[]
  decorations: LaidDecoration[]
  heading: boolean
}

export interface LaidRect {
  x: number
  y: number
  w: number
  h: number
  color: Rgba
  radius: number
}

export interface LaidStroke extends LaidRect {
  width: number
}

export interface LaidLink {
  x: number
  y: number
  w: number
  h: number
  href: string
}

export interface LaidText {
  kind: 'text'
  object: TextObject
  y: number
  h: number
  rects: LaidRect[]
  strokes: LaidStroke[]
  runs: LaidRun[]
  links: LaidLink[]
  rows: Interval[]
  blocks: Interval[]
  /** Right edge of everything drawn (can exceed the box when a table is too wide). */
  right: number
}

export interface LaidPicture {
  kind: 'picture'
  object: ImageObject | SketchObject
  y: number
  h: number
}

export type LaidObject = LaidText | LaidPicture

export interface NoteLayout {
  /** In stacking order (lowest first). */
  objects: LaidObject[]
  left: number
  right: number
  top: number
  bottom: number
  /** Text boxes whose content is wider than the box (wide tables). */
  wideBoxes: number
  /** Text boxes that came out taller than on the canvas (objects below were moved down). */
  grownBoxes: number
}

const BULLETS = ['•', '◦', '▪']

/** Parse a computed CSS colour (`rgb()`/`rgba()`); unknown formats count as opaque black. */
export function parseColor(value: string): Rgba {
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/)
  if (!m) return value === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : { r: 0, g: 0, b: 0, a: 1 }
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  return { r: +m[1], g: +m[2], b: +m[3], a }
}

export function fontKeyFor(family: string, weight: string, style: string): FontKey {
  const mono = /mono|consolas|courier|menlo|monaco/i.test(family)
  const bold = (parseInt(weight, 10) || 400) >= 600 || weight === 'bold'
  const italic = style !== 'normal'
  return `${mono ? 'mono' : 'sans'}${bold || italic ? '-' : ''}${bold ? 'b' : ''}${italic ? 'i' : ''}` as FontKey
}

/** Same DOM details the editor adds: a trailing break in empty textblocks and after a final line break. */
function addTextblockHacks(root: HTMLElement): void {
  for (const block of root.querySelectorAll<HTMLElement>('p, h1, h2, h3, pre > code')) {
    let last: Node | null = block.lastChild
    while (last && last.nodeType === Node.ELEMENT_NODE && (last as Element).tagName !== 'BR' && last.lastChild) last = last.lastChild
    const needs = !last || (last.nodeType === Node.ELEMENT_NODE && (last as Element).tagName === 'BR') || (last.nodeType === Node.TEXT_NODE && /\n$/.test((last as Text).data))
    if (needs) {
      const br = document.createElement('br')
      br.className = 'ProseMirror-trailingBreak'
      block.append(br)
    }
  }
}

/** Tables sit in the same wrapper as in the editor. */
function wrapTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'tableWrapper'
    table.replaceWith(wrap)
    wrap.append(table)
  }
}

/**
 * List markers drawn by the browser (::marker) cannot be measured, so they are
 * replaced by real text placed where the marker was (absolutely positioned,
 * so nothing else moves).
 */
function addListMarkers(root: HTMLElement): void {
  for (const li of root.querySelectorAll<HTMLElement>('li')) {
    const list = li.parentElement
    if (!list) continue
    let text: string
    if (list.tagName === 'OL') {
      const start = parseInt(list.getAttribute('start') ?? '1', 10) || 1
      text = `${start + [...list.children].indexOf(li)}.`
    } else {
      let depth = 0
      for (let p = list.parentElement; p && p !== root; p = p.parentElement) if (p.tagName === 'UL') depth++
      text = BULLETS[Math.min(depth, BULLETS.length - 1)]
    }
    const marker = document.createElement('span')
    marker.className = 'pdf-marker'
    marker.textContent = text
    const first = li.firstElementChild
    if (first) first.prepend(marker)
    else li.prepend(marker)
  }
}

interface Token {
  text: string
  left: number
  right: number
  top: number
  bottom: number
  before: string
}

/** Offset from the top of a text box (range rectangle) to the baseline, per font. */
class BaselineProbe {
  private readonly cache = new Map<string, number>()
  private readonly host: HTMLElement
  constructor(host: HTMLElement) {
    this.host = host
  }
  offset(cs: CSSStyleDeclaration): number {
    const key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontSize}|${cs.fontFamily}`
    let v = this.cache.get(key)
    if (v !== undefined) return v
    const probe = document.createElement('div')
    probe.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;line-height:normal;font-style:${cs.fontStyle};font-weight:${cs.fontWeight};font-size:${cs.fontSize};font-family:${cs.fontFamily}`
    const text = document.createTextNode('Hxg')
    const mark = document.createElement('span')
    mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
    probe.append(text, mark)
    this.host.append(probe)
    const range = document.createRange()
    range.selectNodeContents(text)
    const top = range.getBoundingClientRect().top
    v = mark.getBoundingClientRect().top - top
    probe.remove()
    if (!Number.isFinite(v) || v <= 0) v = parseFloat(cs.fontSize) * 0.8
    this.cache.set(key, v)
    return v
  }
}

const isFormatChar = /\p{Cf}/gu

/** Words of one text node with their rectangles; a word broken across lines is measured per character. */
function tokensOf(node: Text, range: Range): Token[] {
  const data = node.data
  const out: Token[] = []
  const re = /[^\s]+/gu
  let prevEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(data))) {
    const start = m.index
    const end = start + m[0].length
    const ws = data.slice(prevEnd, start)
    prevEnd = end
    range.setStart(node, start)
    range.setEnd(node, end)
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
    if (rects.length === 0) continue
    if (rects.length === 1) {
      const r = rects[0]
      out.push({ text: m[0], left: r.left, right: r.right, top: r.top, bottom: r.bottom, before: ws })
      continue
    }
    // Wrapped inside the word (very long words, URLs): group characters by line.
    let cur: Token | null = null
    let i = start
    for (const ch of m[0]) {
      range.setStart(node, i)
      range.setEnd(node, i + ch.length)
      i += ch.length
      const r = range.getBoundingClientRect()
      if (cur && Math.abs(r.top - cur.top) < 1) {
        cur.text += ch
        cur.right = Math.max(cur.right, r.right)
        cur.bottom = Math.max(cur.bottom, r.bottom)
      } else {
        if (cur) out.push(cur)
        cur = { text: ch, left: r.left, right: r.right, top: r.top, bottom: r.bottom, before: cur ? '' : ws }
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

function decorationsOf(el: HTMLElement, root: HTMLElement): { underline: { color: Rgba; dotted: boolean; offset: number | null } | null; strike: Rgba | null } {
  let underline: { color: Rgba; dotted: boolean; offset: number | null } | null = null
  let strike: Rgba | null = null
  for (let a: HTMLElement | null = el; a; a = a === root ? null : a.parentElement) {
    const cs = getComputedStyle(a)
    const line = cs.textDecorationLine
    if (!line || line === 'none') continue
    const color = parseColor(cs.textDecorationColor || cs.color)
    if (!underline && line.includes('underline')) {
      const off = parseFloat(cs.textUnderlineOffset)
      underline = { color, dotted: cs.textDecorationStyle === 'dotted' || cs.textDecorationStyle === 'dashed', offset: Number.isFinite(off) ? off : null }
    }
    if (!strike && line.includes('line-through')) strike = color
  }
  return { underline, strike }
}

function safeHref(href: string | null): string | null {
  if (!href) return null
  try {
    const u = new URL(href)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * Measure everything drawn inside `root` (backgrounds, borders, text, links)
 * relative to `origin` (a viewport point), shifted by (dx, dy).
 */
export function measureContent(root: HTMLElement, origin: { left: number; top: number }, dx: number, dy: number, probe: BaselineProbe) {
  const X = (v: number) => v - origin.left + dx
  const Y = (v: number) => v - origin.top + dy
  const rects: LaidRect[] = []
  const strokes: LaidStroke[] = []
  const runs: LaidRun[] = []
  const links: LaidLink[] = []
  const rows: Interval[] = []
  const blocks: Interval[] = []
  let right = -Infinity

  const elements = [root, ...root.querySelectorAll<HTMLElement>('*')]
  for (const el of elements) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none') continue
    const inline = cs.display === 'inline'
    const boxes = inline ? [...el.getClientRects()] : [el.getBoundingClientRect()]
    const radius = parseFloat(cs.borderTopLeftRadius) || 0
    const bg = parseColor(cs.backgroundColor)
    for (const b of boxes) {
      if (b.width <= 0 || b.height <= 0) continue
      if (bg.a > 0.004) {
        rects.push({ x: X(b.left), y: Y(b.top), w: b.width, h: b.height, color: bg, radius })
        right = Math.max(right, X(b.right))
      }
    }
    if (!inline) {
      const b = boxes[0]
      const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map((s) => ({
        width: parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) || 0,
        style: cs.getPropertyValue(`border-${s.toLowerCase()}-style`),
        color: parseColor(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)),
      }))
      const visible = sides.map((s) => s.width > 0 && s.style !== 'none' && s.style !== 'hidden' && s.color.a > 0.004)
      if (b && b.width > 0 && b.height > 0 && visible.some(Boolean)) {
        const uniform = visible.every(Boolean) && sides.every((s) => s.width === sides[0].width && s.color.r === sides[0].color.r && s.color.g === sides[0].color.g && s.color.b === sides[0].color.b && s.color.a === sides[0].color.a)
        const collapsed = (el.tagName === 'TD' || el.tagName === 'TH') && cs.borderCollapse === 'collapse'
        if (uniform && radius > 0 && !collapsed) {
          strokes.push({ x: X(b.left), y: Y(b.top), w: b.width, h: b.height, color: sides[0].color, radius, width: sides[0].width })
        } else {
          const [t, r, bo, l] = sides
          const c = (w: number) => (collapsed ? w / 2 : 0)
          if (visible[0]) rects.push({ x: X(b.left) - c(l.width), y: Y(b.top) - c(t.width), w: b.width + c(l.width) + c(r.width), h: t.width, color: t.color, radius: 0 })
          if (visible[2]) rects.push({ x: X(b.left) - c(l.width), y: Y(b.bottom) - bo.width + c(bo.width), w: b.width + c(l.width) + c(r.width), h: bo.width, color: bo.color, radius: 0 })
          if (visible[3]) rects.push({ x: X(b.left) - c(l.width), y: Y(b.top) - c(t.width), w: l.width, h: b.height + c(t.width) + c(bo.width), color: l.color, radius: 0 })
          if (visible[1]) rects.push({ x: X(b.right) - r.width + c(r.width), y: Y(b.top) - c(t.width), w: r.width, h: b.height + c(t.width) + c(bo.width), color: r.color, radius: 0 })
        }
        right = Math.max(right, X(b.right))
      }
      if (b && el.tagName === 'TR') rows.push({ top: Y(b.top), bottom: Y(b.bottom) })
      if (b && /^(P|LI|PRE|BLOCKQUOTE|H1|H2|H3)$/.test(el.tagName)) blocks.push({ top: Y(b.top), bottom: Y(b.bottom) })
    }
    if (el.tagName === 'A') {
      const href = safeHref(el.getAttribute('href'))
      if (href) for (const b of el.getClientRects()) if (b.width > 0) links.push({ x: X(b.left), y: Y(b.top), w: b.width, h: b.height, href })
    }
  }

  const range = document.createRange()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    const el = node.parentElement
    if (!el || !node.data.trim()) continue
    const cs = getComputedStyle(el)
    const tokens = tokensOf(node, range)
    if (tokens.length === 0) continue
    const size = parseFloat(cs.fontSize) || 16
    const font = fontKeyFor(cs.fontFamily, cs.fontWeight, cs.fontStyle)
    const cssFont = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const color = parseColor(cs.color)
    const offset = probe.offset(cs)
    const deco = decorationsOf(el, root)
    const heading = !!el.closest('h1, h2, h3')
    // Group the words by line.
    const lines: Token[][] = []
    for (const t of tokens) {
      const line = lines[lines.length - 1]
      if (line && Math.abs(line[line.length - 1].top - t.top) < 1) line.push(t)
      else {
        const nl = t.before.lastIndexOf('\n')
        lines.push([{ ...t, before: nl >= 0 ? t.before.slice(nl + 1) : lines.length ? '' : t.before.replace(/[^\S\n]/g, ' ') }])
      }
    }
    for (const line of lines) {
      // The most common top is the main font's (fallback fonts can be taller).
      const tops = new Map<number, number>()
      for (const t of line) tops.set(Math.round(t.top * 4) / 4, (tops.get(Math.round(t.top * 4) / 4) ?? 0) + 1)
      const mainTop = [...tops].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
      const baseline = Y(mainTop + offset)
      const words: LaidWord[] = []
      for (const t of line) {
        const text = t.text.replace(isFormatChar, '')
        if (!text) continue
        words.push({ text, raw: t.text, x: X(t.left), w: t.right - t.left, before: t.before ? t.before.replace(isFormatChar, '') : undefined })
      }
      if (words.length === 0) continue
      words[0].before = line[0].before || undefined
      const top = Y(Math.min(...line.map((t) => t.top)))
      const bottom = Y(Math.max(...line.map((t) => t.bottom)))
      const x1 = words[0].x
      const x2 = words[words.length - 1].x + words[words.length - 1].w
      right = Math.max(right, x2)
      const decorations: LaidDecoration[] = []
      const thickness = Math.max(1, size / 15)
      if (deco.underline) decorations.push({ x1, x2, y: baseline + (deco.underline.offset ?? size * 0.12) + thickness / 2, width: thickness, color: deco.underline.color, dotted: deco.underline.dotted })
      if (deco.strike) decorations.push({ x1, x2, y: baseline - size * 0.3, width: thickness, color: deco.strike, dotted: false })
      runs.push({ font, cssFont, size, color, baseline, top, bottom, words, decorations, heading })
    }
  }
  return { rects, strokes, runs, links, rows, blocks, right }
}

export interface LayoutHost {
  host: HTMLElement
  probe: BaselineProbe
  dispose: () => void
}

/** An off-screen container that uses the editor's CSS, themed for the PDF. */
export function createLayoutHost(theme: 'light' | 'dark'): LayoutHost {
  const host = document.createElement('div')
  host.className = `pdf-layout-host pdf-theme-${theme}`
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  return { host, probe: new BaselineProbe(host), dispose: () => host.remove() }
}

/** Render one text box exactly as the editor does (static HTML from the stored document). */
function renderTextBox(host: HTMLElement, obj: TextObject): { frame: HTMLElement; rt: HTMLElement } {
  const frame = document.createElement('div')
  frame.className = 'obj obj-text pdf-frame'
  frame.style.width = `${obj.w}px`
  const links = document.createElement('div')
  links.className = 'obj-text-links'
  const body = document.createElement('div')
  body.className = 'obj-text-body'
  const rt = document.createElement('div')
  rt.className = 'rt tiptap ProseMirror'
  // Schema-generated HTML only (known elements and attributes; validated on save and restore).
  rt.innerHTML = generateHTML(obj.doc, richTextExtensions)
  wrapTables(rt)
  addTextblockHacks(rt)
  addListMarkers(rt)
  body.append(rt)
  links.append(body)
  frame.append(links)
  host.append(frame)
  return { frame, rt }
}

/** Lay out a whole note for export. Objects are returned in stacking order with their export positions. */
export function layoutNote(objects: CanvasObject[], layout: LayoutHost): NoteLayout {
  const measured = new Map<string, { h: number; content: ReturnType<typeof measureContent> }>()
  for (const obj of objects) {
    if (obj.type !== 'text') continue
    const { frame } = renderTextBox(layout.host, obj)
    const box = frame.getBoundingClientRect()
    const content = measureContent(frame, box, obj.x, 0, layout.probe)
    measured.set(obj.id, { h: frame.offsetHeight, content })
    frame.remove()
  }
  const ys = pushDown(objects.map((o) => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, newH: measured.get(o.id)?.h ?? o.h })))
  let grownBoxes = 0
  let wideBoxes = 0
  const laid: LaidObject[] = [...objects]
    .sort((a, b) => a.z - b.z)
    .map((obj) => {
      const y = ys.get(obj.id) ?? obj.y
      if (obj.type !== 'text') return { kind: 'picture', object: obj, y, h: obj.h }
      const m = measured.get(obj.id)!
      if (m.h > obj.h + 1) grownBoxes++
      if (m.content.right > obj.x + obj.w + 1) wideBoxes++
      const sy = (v: number) => v + y
      const c = m.content
      return {
        kind: 'text',
        object: obj,
        y,
        h: m.h,
        rects: c.rects.map((r) => ({ ...r, y: sy(r.y) })),
        strokes: c.strokes.map((r) => ({ ...r, y: sy(r.y) })),
        runs: c.runs.map((r) => ({ ...r, top: sy(r.top), bottom: sy(r.bottom), baseline: sy(r.baseline), decorations: r.decorations.map((d) => ({ ...d, y: sy(d.y) })) })),
        links: c.links.map((l) => ({ ...l, y: sy(l.y) })),
        rows: c.rows.map((r) => ({ top: sy(r.top), bottom: sy(r.bottom) })),
        blocks: c.blocks.map((r) => ({ top: sy(r.top), bottom: sy(r.bottom) })),
        right: Math.max(obj.x + obj.w, c.right),
      }
    })
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const o of laid) {
    left = Math.min(left, o.object.x)
    right = Math.max(right, o.kind === 'text' ? o.right : o.object.x + o.object.w)
    top = Math.min(top, o.y)
    bottom = Math.max(bottom, o.y + o.h)
  }
  if (laid.length === 0) {
    left = 0
    right = 1
    top = 0
    bottom = 0
  }
  return { objects: laid, left, right, top, bottom, wideBoxes, grownBoxes }
}

/** Lines of text in a laid-out text object, for page breaks. */
export function textLines(o: LaidText): TextLine[] {
  return o.runs.map((r) => ({ top: r.top, bottom: r.bottom, heading: r.heading }))
}

/** Measure a small block of plain text (the PDF's title block), in its own pixel space. */
export function measureTitleBlock(layout: LayoutHost, title: string, meta: string, widthPx: number) {
  const frame = document.createElement('div')
  frame.className = 'pdf-title-block'
  frame.style.width = `${widthPx}px`
  const h = document.createElement('div')
  h.className = 'pdf-title'
  h.textContent = title
  const m = document.createElement('div')
  m.className = 'pdf-meta'
  m.textContent = meta
  frame.append(h, m)
  layout.host.append(frame)
  const box = frame.getBoundingClientRect()
  const content = measureContent(frame, box, 0, 0, layout.probe)
  const height = frame.offsetHeight
  frame.remove()
  return { content, height }
}
