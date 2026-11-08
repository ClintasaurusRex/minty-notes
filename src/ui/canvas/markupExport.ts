import { emptyMarkup } from '../../domain/markup'
import type { ImageObject, SketchObject } from '../../domain/types'
import { renderMarkupPng } from '../../export/markupRaster'
import { saveBytesAsDownload } from '../../platform/download'
import { notify } from '../notices'
import { SKETCH_BACKGROUND } from './markupHelpers'

export { renderMarkupPng } from '../../export/markupRaster'

/** File name for an exported copy, e.g. "Screenshot 2026-11-03 (marked up).png". */
export function markedUpName(original: string): string {
  const base = original.replace(/\.[a-z0-9]{1,5}$/i, '') || 'image'
  return `${base} (marked up).png`
}

/** Download a flattened PNG of a marked-up image or sketch without opening the editor. */
export async function savePngCopy(obj: ImageObject | SketchObject, getBlob: (id: string) => Promise<Blob | undefined>, fileName: string): Promise<void> {
  try {
    const image = obj.type === 'image' ? ((await getBlob(obj.attachmentId)) ?? null) : null
    if (obj.type === 'image' && !image) throw new Error('the image file is missing')
    const markup = obj.markup ?? emptyMarkup(obj.w, obj.h)
    const blob = await renderMarkupPng(markup, image, obj.type === 'sketch' ? SKETCH_BACKGROUND : null)
    saveBytesAsDownload(new Uint8Array(await blob.arrayBuffer()), markedUpName(fileName), 'image/png')
    notify('success', 'Saved a flattened PNG copy. Redacted areas are solid black in that file; the original stays unchanged in Minty Notes.')
  } catch (err) {
    notify('error', `The PNG copy could not be made: ${err instanceof Error ? err.message : String(err)}`)
  }
}
