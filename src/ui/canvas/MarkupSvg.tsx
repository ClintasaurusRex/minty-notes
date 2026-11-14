import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react'
import { arrowHead, LABEL_LINE_HEIGHT, LABEL_PAD, REDACT_COLOR, visibleRect } from '../../domain/markup'
import type { Annotation, Markup, MarkupRect } from '../../domain/types'
import { blurRadius, LABEL_FONT, measureLabel } from './markupHelpers'

interface Props {
  markup: Markup
  /** Image under the markup (images only). */
  imageUrl?: string | null
  /** Unique per object, for clip/filter ids. */
  idPrefix: string
  /** Visible area; defaults to the crop (the editor shows the whole image while cropping). */
  view?: MarkupRect
  /** Editor: an annotation being drawn, the selection, and hit areas. */
  draft?: Annotation | null
  interactive?: boolean
  hiddenId?: string | null
  className?: string
  svgRef?: Ref<SVGSVGElement>
  onPointerDown?: (e: ReactPointerEvent<SVGSVGElement>) => void
  onPointerMove?: (e: ReactPointerEvent<SVGSVGElement>) => void
  onPointerUp?: (e: ReactPointerEvent<SVGSVGElement>) => void
  onDoubleClick?: (e: ReactMouseEvent<SVGSVGElement>) => void
  children?: ReactNode
  label?: string
  preserveAspect?: boolean
}

function Item({ a, interactive }: { a: Annotation; interactive: boolean }) {
  const hit = interactive ? { 'data-id': a.id } : {}
  switch (a.kind) {
    case 'arrow':
    case 'line': {
      const head = a.kind === 'arrow' ? arrowHead(a.x1, a.y1, a.x2, a.y2, a.width) : null
      // Stop the line inside the head so the tip stays sharp.
      const back = head ? Math.max(10, a.width * 4) * 0.6 : 0
      const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1
      const ex = a.x2 - ((a.x2 - a.x1) / len) * Math.min(back, len)
      const ey = a.y2 - ((a.y2 - a.y1) / len) * Math.min(back, len)
      return (
        <g {...hit} className="mk-item">
          {interactive && <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} className="mk-hit" strokeWidth={Math.max(a.width * 3, 14)} />}
          <line x1={a.x1} y1={a.y1} x2={ex} y2={ey} stroke={a.color} strokeWidth={a.width} strokeLinecap="round" />
          {head && <polygon points={head.map((p) => p.join(',')).join(' ')} fill={a.color} />}
        </g>
      )
    }
    case 'rect':
      return (
        <g {...hit} className="mk-item">
          {interactive && <rect x={a.x} y={a.y} width={a.w} height={a.h} className="mk-hit" strokeWidth={Math.max(a.width * 3, 14)} fill={a.fill ? 'transparent' : 'none'} />}
          <rect x={a.x} y={a.y} width={a.w} height={a.h} stroke={a.color} strokeWidth={a.width} fill={a.fill ?? 'none'} rx={Math.min(a.width, 6)} />
        </g>
      )
    case 'ellipse':
      return (
        <g {...hit} className="mk-item">
          {interactive && <ellipse cx={a.x + a.w / 2} cy={a.y + a.h / 2} rx={a.w / 2} ry={a.h / 2} className="mk-hit" strokeWidth={Math.max(a.width * 3, 14)} fill={a.fill ? 'transparent' : 'none'} />}
          <ellipse cx={a.x + a.w / 2} cy={a.y + a.h / 2} rx={a.w / 2} ry={a.h / 2} stroke={a.color} strokeWidth={a.width} fill={a.fill ?? 'none'} />
        </g>
      )
    case 'text': {
      const lines = a.text.split('\n')
      const pad = a.size * LABEL_PAD
      const w = measureLabel(a.text, a.size)
      return (
        <g {...hit} className="mk-item">
          <rect x={a.x - pad} y={a.y - pad} width={w + pad * 2} height={lines.length * a.size * LABEL_LINE_HEIGHT + pad * 2} rx={pad} fill={a.background ?? 'transparent'} />
          <text x={a.x} y={a.y} fill={a.color} fontSize={a.size} fontFamily={LABEL_FONT} dominantBaseline="hanging">
            {lines.map((line, i) => (
              <tspan key={i} x={a.x} dy={i === 0 ? 0 : a.size * LABEL_LINE_HEIGHT}>
                {line || ' '}
              </tspan>
            ))}
          </text>
        </g>
      )
    }
    case 'pen':
    case 'highlighter': {
      const pts: string[] = []
      for (let i = 0; i < a.points.length; i += 2) pts.push(`${a.points[i]},${a.points[i + 1]}`)
      if (pts.length === 1) pts.push(pts[0])
      return (
        <g {...hit} className="mk-item">
          {interactive && <polyline points={pts.join(' ')} className="mk-hit" strokeWidth={Math.max(a.width * 2, 14)} fill="none" />}
          <polyline
            points={pts.join(' ')}
            stroke={a.color}
            strokeWidth={a.width}
            strokeOpacity={a.kind === 'highlighter' ? 0.38 : 1}
            strokeLinecap={a.kind === 'highlighter' ? 'square' : 'round'}
            strokeLinejoin="round"
            fill="none"
          />
        </g>
      )
    }
    case 'redact':
      return <rect {...hit} className="mk-item" x={a.x} y={a.y} width={a.w} height={a.h} fill={REDACT_COLOR} />
    case 'blur':
      return interactive ? <rect {...hit} className="mk-item mk-blur-outline" x={a.x} y={a.y} width={a.w} height={a.h} fill="transparent" /> : null
  }
}

/**
 * Renders a markup as SVG in its own coordinate space: the image (if any),
 * blurred areas, redaction boxes, then the other annotations in order.
 */
export function MarkupSvg({ markup, imageUrl, idPrefix, view, draft, interactive = false, hiddenId, className, svgRef, children, label, preserveAspect, ...events }: Props) {
  const v = view ?? visibleRect(markup)
  const items = draft ? [...markup.items, draft] : markup.items
  const shown = items.filter((a) => a.id !== hiddenId)
  const areas = shown.filter((a) => a.kind === 'blur' || a.kind === 'redact')
  const others = shown.filter((a) => a.kind !== 'blur' && a.kind !== 'redact')
  const blurs = imageUrl ? areas.filter((a): a is Extract<Annotation, { kind: 'blur' | 'redact' }> => a.kind === 'blur') : []
  const r = blurRadius(markup)
  const safe = idPrefix.replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg
      ref={svgRef}
      className={className}
      viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
      preserveAspectRatio={preserveAspect ? 'xMidYMid meet' : 'none'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...events}
    >
      <defs>
        {blurs.map((b) => (
          <g key={b.id}>
            <clipPath id={`${safe}-c-${b.id}`}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} />
            </clipPath>
            <filter id={`${safe}-f-${b.id}`} filterUnits="userSpaceOnUse" x={b.x - r * 3} y={b.y - r * 3} width={b.w + r * 6} height={b.h + r * 6}>
              <feGaussianBlur stdDeviation={r} />
            </filter>
          </g>
        ))}
      </defs>
      {imageUrl && <image href={imageUrl} x={0} y={0} width={markup.width} height={markup.height} preserveAspectRatio="none" />}
      {blurs.map((b) => (
        <g key={b.id} clipPath={`url(#${safe}-c-${b.id})`}>
          <image href={imageUrl!} x={0} y={0} width={markup.width} height={markup.height} preserveAspectRatio="none" filter={`url(#${safe}-f-${b.id})`} />
        </g>
      ))}
      {areas.map((a) => (
        <Item key={a.id} a={a} interactive={interactive} />
      ))}
      {others.map((a) => (
        <Item key={a.id} a={a} interactive={interactive} />
      ))}
      {children}
    </svg>
  )
}
