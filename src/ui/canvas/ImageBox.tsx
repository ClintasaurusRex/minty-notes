import { useEffect, useState } from 'react'
import { useServices, useWorkspace } from '../../app/context'
import type { ImageObject } from '../../domain/types'
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
  const url = useAttachmentUrl(obj.attachmentId)
  const meta = useWorkspace((s) => s.data.attachments[obj.attachmentId])
  const name = obj.alt || meta?.fileName || 'Image'
  return (
    <ObjectFrame obj={obj} handles={['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']} label={`Image: ${name}`} bodyDrag>
      {url ? (
        <img src={url} alt={obj.alt} draggable={false} decoding="async" />
      ) : (
        <div className="img-placeholder">{url === null ? 'Image file missing' : 'Loading image…'}</div>
      )}
    </ObjectFrame>
  )
}
