import { markupText } from '../../domain/markup'
import type { SketchObject } from '../../domain/types'
import { useCanvas } from './CanvasContext'
import { MarkupSvg } from './MarkupSvg'
import { ObjectFrame } from './ObjectFrame'

/** A vector sketch on the page (lines, arrows, shapes, labels, pen). Double-click or Enter edits it. */
export function SketchBox({ obj }: { obj: SketchObject }) {
  const api = useCanvas()
  const labels = markupText(obj.markup).replace(/\n/g, ', ')
  return (
    <ObjectFrame obj={obj} handles={['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']} label={`Sketch${labels ? `: ${labels.slice(0, 80)}` : ''}`} bodyDrag onEnter={() => api.openMarkup(obj.id)} enterHint="Enter edits the sketch">
      <div className="sketch-body" onDoubleClick={() => api.openMarkup(obj.id)}>
        <MarkupSvg markup={obj.markup} idPrefix={obj.id} className="markup-view" />
        {obj.markup.items.length === 0 && <span className="sketch-empty">Empty sketch — double-click to draw</span>}
      </div>
    </ObjectFrame>
  )
}
