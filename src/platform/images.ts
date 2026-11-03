import { sha256Hex } from '../backup/archive'
import { newId, nowIso, type AttachmentMeta } from '../domain/types'

function readImageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.src = url
  return img
    .decode()
    .then(() => (img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null))
    .catch(() => null)
    .finally(() => URL.revokeObjectURL(url))
}

function screenshotName(file: Blob & { name?: string }, type: string): string {
  const name = file.name && file.name !== 'image.png' ? file.name : ''
  if (name) return name
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.')
  const ext = type.split('/')[1]?.replace('svg+xml', 'svg').replace('jpeg', 'jpg') ?? 'png'
  return `Screenshot ${stamp}.${ext}`
}

/** Read an image into an attachment record plus its bytes. Throws if it cannot be decoded. */
export async function prepareImage(file: Blob & { name?: string }, source: AttachmentMeta['source']): Promise<{ meta: AttachmentMeta; blob: Blob }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const size = await readImageSize(file)
  if (!size && file.type !== 'image/svg+xml') throw new Error('The image could not be read.')
  const blob = new Blob([bytes], { type: file.type })
  const meta: AttachmentMeta = {
    id: newId(),
    fileName: screenshotName(file, file.type),
    mimeType: file.type,
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    width: size?.width ?? null,
    height: size?.height ?? null,
    source,
    createdAt: nowIso(),
  }
  return { meta, blob }
}
