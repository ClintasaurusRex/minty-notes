import { useEffect, useState } from 'react'
import { useServices, useWorkspace } from '../../app/context'
import { hasMarkup } from '../../domain/markup'
import type { ImageObject } from '../../domain/types'
import { useCanvas } from './CanvasContext'
import { MarkupSvg } from './MarkupSvg'
import { ObjectFrame } from './ObjectFrame'

function useAttachmentUrl(id: string): string | null | undefined {
  const { attachments } = useServices()
  const [loaded, setLoaded] = useState<{ id: string; url: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    void attachments.get(id).then((url) => {
      if (alive) setLoaded({ id, url })
    })
    return () => {
      alive = false
    }
  }, [attachments, id])
  if (loaded?.id === id) return loaded.url
  return attachments.peek(id)
}

export function ImageBox({ obj }: { obj: ImageObject }) {
  const api = useCanvas()
  const url = useAttachmentUrl(obj.attachmentId)
  const meta = useWorkspace((s) => s.data.attachments[obj.attachmentId])
  const name = obj.alt || meta?.fileName || 'Image'
  const marked = hasMarkup(obj.markup)
  return (
    <ObjectFrame
      obj={obj}
      handles={['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']}
      label={`Image: ${name}${marked ? ' (marked up)' : ''}`}
      bodyDrag
      onEnter={() => api.openMarkup(obj.id)}
      enterHint="Enter marks it up"
    >
      {url && marked ? (
        // The original stays untouched; markup and crop are drawn over it.
        <div className="img-marked" onDoubleClick={() => api.openMarkup(obj.id)}>
          <MarkupSvg markup={obj.markup!} imageUrl={url} idPrefix={obj.id} className="markup-view" label={obj.alt || `Marked-up image: ${name}`} />
        </div>
      ) : url ? (
        <img src={url} alt={obj.alt} draggable={false} decoding="async" onDoubleClick={() => api.openMarkup(obj.id)} />
      ) : (
        <div className="img-placeholder">{url === null ? 'Image file missing' : 'Loading image…'}</div>
      )}
    </ObjectFrame>
  )
}
