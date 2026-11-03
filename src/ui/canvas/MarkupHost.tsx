import { useEffect, useState } from 'react'
import { useServices, useWorkspace } from '../../app/context'
import { emptyMarkup } from '../../domain/markup'
import type { CanvasObject, ImageObject, Markup, SketchObject } from '../../domain/types'
import { MarkupEditor } from './MarkupEditor'
import { markupPatch, naturalSize, SKETCH_BACKGROUND } from './markupHelpers'

/** Opens the markup editor for one image or sketch once its image and size are known. */
export function MarkupHost({ obj, pageWidth, onDone, onCancel }: { obj: ImageObject | SketchObject; pageWidth: number; onDone: (patch: Partial<CanvasObject>) => void; onCancel: () => void }) {
  const { attachments, store } = useServices()
  const meta = useWorkspace((s) => (obj.type === 'image' ? s.data.attachments[obj.attachmentId] : undefined))
  const [ready, setReady] = useState<{ url: string | null; markup: Markup } | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (obj.type === 'sketch') {
        if (alive) setReady({ url: null, markup: obj.markup })
        return
      }
      const url = await attachments.get(obj.attachmentId)
      const size = obj.markup ? { width: obj.markup.width, height: obj.markup.height } : meta?.width && meta.height ? { width: meta.width, height: meta.height } : await naturalSize(url, { width: obj.w, height: obj.h })
      if (alive) setReady({ url, markup: obj.markup ?? emptyMarkup(size.width, size.height) })
    })()
    return () => {
      alive = false
    }
    // Only when a different object is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.id])

  if (!ready) return null
  return (
    <MarkupEditor
      kind={obj.type}
      initial={ready.markup}
      imageUrl={ready.url}
      background={obj.type === 'sketch' ? SKETCH_BACKGROUND : null}
      fileName={obj.type === 'image' ? (meta?.fileName ?? 'image') : 'Sketch'}
      getImage={async () => (obj.type === 'image' ? ((await store.getBlob(obj.attachmentId)) ?? null) : null)}
      idPrefix={obj.id}
      onDone={(m) => onDone(markupPatch(obj, m, pageWidth))}
      onCancel={onCancel}
    />
  )
}
