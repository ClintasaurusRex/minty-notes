import { MAX_DOCX_IMAGES } from './formats'

/** Word → HTML with mammoth (runs in a worker; no DOM needed). */
export interface DocxImage {
  index: number
  contentType: string
  bytes: Uint8Array
  alt: string
}

export interface DocxConversion {
  html: string
  images: DocxImage[]
  /** Converter messages (unrecognised styles, unsupported content). */
  messages: string[]
  skippedImages: number
}

/** `<img src="minty-image:N">` marks where embedded image N appeared. */
export const IMAGE_PLACEHOLDER = 'minty-image:'

export async function convertDocxToHtml(bytes: ArrayBuffer): Promise<DocxConversion> {
  const mammoth = (await import('mammoth')).default
  const images: DocxImage[] = []
  let skippedImages = 0
  const result = await mammoth.convertToHtml(
    { arrayBuffer: bytes },
    {
      // Keep underline and strike-through; Title/Subtitle become headings.
      styleMap: ['u => u', 'strike => s', "p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
      // Never read files outside the document (linked images, etc.).
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        if (images.length >= MAX_DOCX_IMAGES) {
          skippedImages++
          return { src: '' }
        }
        const index = images.length
        images.push({ index, contentType: image.contentType, bytes: new Uint8Array(await image.readAsArrayBuffer()), alt: '' })
        return { src: `${IMAGE_PLACEHOLDER}${index}` }
      }),
    },
  )
  return { html: result.value, images, messages: result.messages.map((m) => m.message), skippedImages }
}
