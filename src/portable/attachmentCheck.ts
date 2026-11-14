import { checkDocxContainer, detectFormat } from '../import/formats'

/**
 * What a file in a project package really is, judged from its bytes (pure, no
 * DOM, nothing is decoded or run). A matching checksum only proves that a file
 * was not changed after export; these checks prove that it is the kind of file
 * its record says it is.
 *
 * Pictures are the seven types the app accepts when one is pasted, dropped, or
 * chosen. Documents use the same checks as “Import document”
 * (`detectFormat`, `checkDocxContainer`).
 */

/** Image types a note can hold (the same list as the canvas accepts). */
export const PACKAGE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/svg+xml'] as const
export type PackageImageType = (typeof PACKAGE_IMAGE_TYPES)[number]

export function isPackageImageType(mimeType: string): mimeType is PackageImageType {
  return (PACKAGE_IMAGE_TYPES as readonly string[]).includes(mimeType)
}

const ascii = (bytes: Uint8Array, at: number, text: string) => bytes.byteLength >= at + text.length && [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0))
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

/** How much of a text file is looked at to find the `<svg>` root element. */
const SVG_SCAN_BYTES = 256 * 1024
const BMP_HEADER_SIZES = [12, 40, 52, 56, 64, 108, 124]

function isSvg(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, SVG_SCAN_BYTES)
  let text: string
  try {
    const utf16 = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : null
    // `stream` tolerates a character cut in half at the end of the part looked at; anything else invalid is refused.
    text = new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(head, { stream: true })
  } catch {
    return false
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return false
  // Skip what may come before the root element: XML declaration, comments, a DOCTYPE, processing instructions.
  let rest = text.replace(/^\ufeff/, '')
  for (;;) {
    rest = rest.trimStart()
    const skip = /^<\?[\s\S]*?\?>/.exec(rest) ?? /^<!--[\s\S]*?-->/.exec(rest) ?? /^<!DOCTYPE(?:[^[\]>]|\[[^\]]*\])*>/i.exec(rest)
    if (!skip) break
    rest = rest.slice(skip[0].length)
  }
  return /^<(?:[A-Za-z_][\w.-]*:)?svg[\s/>]/.test(rest)
}

/**
 * The image type these bytes are, or null when they are none of the supported
 * types. Looks at signatures and the first header only.
 */
export function sniffImageType(bytes: Uint8Array): PackageImageType | null {
  if (bytes.byteLength < 8) return null
  if (u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) return bytes.byteLength >= 24 && ascii(bytes, 12, 'IHDR') ? 'image/png' : null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif'
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp'
  if (ascii(bytes, 4, 'ftyp')) {
    // ISO media file: AVIF when "avif" or "avis" is its main or a compatible brand.
    const end = Math.min(u32be(bytes, 0), bytes.byteLength, 1024)
    for (let o = 8; o + 4 <= end; o += o === 8 ? 8 : 4) if (ascii(bytes, o, 'avif') || ascii(bytes, o, 'avis')) return 'image/avif'
    return null
  }
  if (ascii(bytes, 0, 'BM') && bytes.byteLength >= 26 && BMP_HEADER_SIZES.includes(u32le(bytes, 14)) && u32le(bytes, 10) <= bytes.byteLength) return 'image/bmp'
  return isSvg(bytes) ? 'image/svg+xml' : null
}

const IMAGE_NAMES: Record<PackageImageType, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'image/bmp': 'BMP', 'image/avif': 'AVIF', 'image/svg+xml': 'SVG' }

export function imageTypeName(mimeType: string): string {
  return isPackageImageType(mimeType) ? IMAGE_NAMES[mimeType] : mimeType.slice(0, 60)
}

/**
 * Check that a picture's bytes are of the type its record declares. Returns
 * what is wrong (a sentence that follows the file's name), or null.
 */
export function imageProblem(mimeType: string, bytes: Uint8Array): string | null {
  if (!isPackageImageType(mimeType)) return `has a picture type Minty Notes does not use (${mimeType.slice(0, 60)})`
  const actual = sniffImageType(bytes)
  if (actual === mimeType) return null
  return actual ? `is recorded as a ${IMAGE_NAMES[mimeType]} picture but is a ${IMAGE_NAMES[actual]} file` : `is not the ${IMAGE_NAMES[mimeType]} picture it claims to be`
}

/**
 * Check that an imported document's original file is the PDF or Word document
 * it claims to be, with the checks “Import document” makes: the PDF marker, or
 * a readable DOCX container that holds `word/document.xml` within the import
 * limits. Returns what is wrong, or null.
 */
export async function originalProblem(format: 'pdf' | 'docx', fileName: string, bytes: Uint8Array): Promise<string | null> {
  const claim = `is not the ${format.toUpperCase()} document it claims to be`
  const detected = detectFormat(fileName, bytes)
  if (!detected.ok || detected.format !== format) return claim
  if (format === 'docx') {
    const container = await checkDocxContainer(fileName, bytes)
    if (!container.ok) return `${claim} (it is not a readable Word file)`
  }
  return null
}
