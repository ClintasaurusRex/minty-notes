import sansUrl from './fonts/LiberationSans-Regular.ttf?url'
import sansBoldUrl from './fonts/LiberationSans-Bold.ttf?url'
import sansItalicUrl from './fonts/LiberationSans-Italic.ttf?url'
import sansBoldItalicUrl from './fonts/LiberationSans-BoldItalic.ttf?url'
import monoUrl from './fonts/DejaVuSansMono.ttf?url'
import monoBoldUrl from './fonts/DejaVuSansMono-Bold.ttf?url'
import type { FontKey } from './layoutNote'
import { parseTrueType, type TrueTypeFont } from './trueType'

/**
 * Fonts embedded in exported PDFs (open licences; see fonts/LICENSE-*.txt):
 * Liberation Sans (SIL OFL 1.1) for text, DejaVu Sans Mono (Bitstream Vera
 * licence) for code. They are part of the app build, so export works offline.
 * Monospaced italics are slanted from the upright faces.
 */
const FILES = { sans: sansUrl, 'sans-b': sansBoldUrl, 'sans-i': sansItalicUrl, 'sans-bi': sansBoldItalicUrl, mono: monoUrl, 'mono-b': monoBoldUrl } as const
type FontFile = keyof typeof FILES

export function fontFileFor(key: FontKey): { file: FontFile; fakeItalic: boolean } {
  if (key === 'mono-i') return { file: 'mono', fakeItalic: true }
  if (key === 'mono-bi') return { file: 'mono-b', fakeItalic: true }
  return { file: key, fakeItalic: false }
}

const cache = new Map<FontFile, Promise<TrueTypeFont>>()

export function loadFont(file: FontFile): Promise<TrueTypeFont> {
  let p = cache.get(file)
  if (!p) {
    p = fetch(FILES[file])
      .then((res) => {
        if (!res.ok) throw new Error(`the PDF font could not be loaded (${res.status})`)
        return res.arrayBuffer()
      })
      .then((buf) => parseTrueType(new Uint8Array(buf)))
    p.catch(() => cache.delete(file))
    cache.set(file, p)
  }
  return p
}
