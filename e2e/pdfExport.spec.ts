import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { makeTechnicalPdf } from '../src/test/docFixtures'
import { addTextBox, geometry, newQuickNote, pasteScreenshot, waitSaved } from './helpers'
import { containsBytes, countColor, inspectPdf, pixelAt, type PdfReport } from './pdfInspect'

/**
 * Note-to-PDF export in real Chromium (production build). Every check that
 * matters is made on the downloaded PDF file itself, read in Node by a raw
 * parser written for these tests (structure, every stream, every image's
 * decoded pixels) and by PDF.js (text, links, page sizes) — not on the preview.
 */

const RICH_HTML = `
<h1>Commissioning checklist</h1>
<p>Normal text with <strong>bold words</strong>, <em>italic words</em>, <u>underlined words</u>, <s>struck words</s>, <code>inline_code()</code> and a <a href="https://example.com/manual">web link to the manual</a>.</p>
<ul><li><p>First bullet</p></li><li><p>Second bullet</p><ul><li><p>Nested bullet</p></li></ul></li></ul>
<ol><li><p>Step one</p></li><li><p>Step two</p></li></ol>
<blockquote><p>Quoted warning text</p></blockquote>
<table><tbody><tr><th><p>Tag</p></th><th><p>Address</p></th><th><p>State</p></th></tr><tr><td><p>P101_RUN</p></td><td><p>Local:1:I.Data.0</p></td><td><p>OK</p></td></tr></tbody></table>
<pre><code>IF LSH_101 THEN Start_Lag := 1; END_IF; (* lag pump starts on high level; this comment is long enough to wrap inside the code block *)</code></pre>
<p>Units: 20 °C ± 0.5, 4–20 mA, 120 Ω → done</p>`

const pad3 = (n: number) => String(n).padStart(3, '0')
const LONG_LINES = Array.from({ length: 160 }, (_, i) => `Line ${pad3(i + 1)} check valve and record the reading`)

async function pasteClipboard(page: Page, items: Record<string, string>) {
  await page.evaluate(async (data) => {
    const entries = Object.fromEntries(Object.entries(data).map(([type, value]) => [type, new Blob([value], { type })]))
    await navigator.clipboard.write([new ClipboardItem(entries)])
  }, items)
  // Paste on the page itself (no text box focused): a new text box is made.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByTestId('page-surface').focus()
  await page.keyboard.press('ControlOrMeta+V')
}

/** A 480 × 280 "HMI screenshot" with a magenta secret at (300, 40)–(400, 90). */
async function pasteSecretScreenshot(page: Page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 480
    c.height = 280
    const g = c.getContext('2d')!
    g.fillStyle = '#2b3442'
    g.fillRect(0, 0, 480, 280)
    g.fillStyle = '#6ee7b7'
    g.fillRect(16, 16, 200, 90)
    g.fillStyle = '#ff00ff'
    g.fillRect(300, 40, 100, 50)
    g.fillStyle = '#ffffff'
    g.font = '24px sans-serif'
    g.fillText('PUMP 1 FAULT', 24, 220)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByTestId('page-surface').focus()
  await page.keyboard.press('ControlOrMeta+V')
}

async function toClient(page: Page, x: number, y: number) {
  const [cx, cy] = await page.locator('.markup-svg').evaluate((svg, [px, py]) => {
    const p = new DOMPoint(px, py).matrixTransform((svg as SVGSVGElement).getScreenCTM()!)
    return [p.x, p.y]
  }, [x, y])
  return { x: cx, y: cy }
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await toClient(page, ...from)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  const b = await toClient(page, ...to)
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.mouse.up()
}

/** Stored records of a page and the SHA-256 of every stored attachment, read straight from IndexedDB. */
async function storedState(page: Page, title: string) {
  return page.evaluate(async (t) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('minty-notes')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const all = <T,>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).getAll()
        req.onsuccess = () => resolve(req.result as T[])
        req.onerror = () => reject(req.error)
      })
    const pages = await all<{ id: string; title: string }>('pages')
    const p = pages.find((x) => x.title === t)!
    const objects = (await all<{ pageId: string; id: string }>('objects')).filter((o) => o.pageId === p.id).sort((a, b) => a.id.localeCompare(b.id))
    const blobs: Record<string, string> = {}
    const tx = db.transaction('blobs')
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const req = tx.objectStore('blobs').getAllKeys()
      req.onsuccess = () => resolve(req.result)
    })
    for (const key of keys) {
      const blob = await new Promise<Blob>((resolve) => {
        const req = db.transaction('blobs').objectStore('blobs').get(key)
        req.onsuccess = () => resolve(req.result as Blob)
      })
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      blobs[String(key)] = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    }
    db.close()
    return { page: JSON.stringify(p), objects: JSON.stringify(objects), blobs }
  }, title)
}

async function exportPdf(page: Page, testInfo: { outputPath: (name: string) => string }, name: string): Promise<{ report: PdfReport; notes: string }> {
  const dialog = page.getByTestId('pdf-export')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('pdf-status')).toContainText('Ready', { timeout: 60_000 })
  // The preview is the generated file drawn by PDF.js.
  await expect(dialog.getByTestId('preview-canvas')).toBeVisible()
  await expect
    .poll(() => dialog.getByTestId('preview-canvas').evaluate((c) => {
      const canvas = c as HTMLCanvasElement
      if (!canvas.width) return 0
      const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let i = 0; i < d.length; i += 16) if (d[i] < 128) ink++
      return ink
    }))
    .toBeGreaterThan(50)
  const notes = (await dialog.getByTestId('pdf-notes').textContent()) ?? ''
  const download = page.waitForEvent('download')
  await dialog.getByTestId('pdf-download').click()
  const file = await download
  const path = testInfo.outputPath(name)
  await file.saveAs(path)
  expect(file.suggestedFilename()).toMatch(/\.pdf$/)
  return { report: await inspectPdf(new Uint8Array(readFileSync(path))), notes }
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ')

test('note PDF export: rich text, table, code, links, a redacted screenshot, a sketch, and a long note over several pages — checked in the file', async ({ page }, testInfo) => {
  await page.goto('/')
  await newQuickNote(page)
  const title = 'Pump station 4 — commissioning'
  await page.getByLabel('Page title').fill(title)

  await pasteClipboard(page, { 'text/html': RICH_HTML, 'text/plain': 'Commissioning checklist' })
  await expect(page.locator('.obj-text')).toHaveCount(1)
  await expect(page.locator('.obj-text table')).toHaveCount(1)

  // Screenshot with a secret, redacted in the markup editor, plus an arrow.
  await pasteSecretScreenshot(page)
  const image = page.locator('.obj-image')
  await expect(image.locator('img')).toHaveCount(1)
  const originalPng = await image.locator('img').evaluate(async (el) => Array.from(new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer())))
  await image.click()
  await page.getByRole('button', { name: /^Mark up:/ }).click()
  const editor = page.getByTestId('markup-editor')
  await expect(editor).toBeVisible()
  await drag(page, [40, 160], [150, 110]) // arrow (default tool)
  await page.keyboard.press('x')
  await drag(page, [295, 35], [405, 95]) // redaction over the magenta block
  await expect(editor.locator('.markup-svg [data-id]')).toHaveCount(2)
  await editor.getByTestId('markup-done').click()
  await expect(editor).toBeHidden()

  // A sketch with a label.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Add a sketch/ }).click()
  await expect(editor).toBeVisible()
  await expect(page.locator('.markup-stage')).toBeFocused()
  await page.keyboard.press('r')
  await page.keyboard.press('Enter')
  await page.keyboard.press('t')
  await page.keyboard.press('Enter')
  await page.getByLabel('Label text').fill('K1 coil to X2:14')
  await page.getByLabel('Label text').press('Enter')
  await editor.getByTestId('markup-done').click()
  await expect(page.locator('.obj-sketch')).toHaveCount(1)

  // A long text box (160 lines) so the note needs several sheets.
  await pasteClipboard(page, { 'text/plain': LONG_LINES.join('\n') })
  await expect(page.locator('.obj-text')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await waitSaved(page)
  const before = await storedState(page, title)

  await page.getByTestId('export-pdf').click()
  const { report, notes } = await exportPdf(page, testInfo, 'note.pdf')
  expect(notes).toContain('1 redaction box')
  expect(notes).toMatch(/\d+ pages on Letter paper/)

  // The file: title, sheets, and every piece of text exactly once, in order.
  expect(report.title).toBe(title)
  expect(report.pages.length).toBeGreaterThanOrEqual(4)
  for (const p of report.pages) expect([Math.round(p.width), Math.round(p.height)]).toEqual([612, 792])
  const all = norm(report.pages.map((p) => p.text).join('\n'))
  expect(norm(report.pages[0].text)).toContain(title)
  for (const s of ['Commissioning checklist', 'bold words', 'italic words', 'underlined words', 'struck words', 'inline_code()', 'web link to the manual', 'First bullet', 'Nested bullet', 'Step one', 'Step two', 'Quoted warning text', 'Tag', 'Address', 'P101_RUN', 'Local:1:I.Data.0', 'IF LSH_101 THEN Start_Lag := 1; END_IF;', 'long enough to wrap', 'Units: 20 °C ± 0.5, 4–20 mA, 120 Ω → done']) {
    expect(all, s).toContain(norm(s))
  }
  let last = -1
  for (const line of LONG_LINES) {
    const at = all.indexOf(line)
    expect(at, `${line} is in the PDF`).toBeGreaterThan(last)
    expect(all.indexOf(line, at + 1), `${line} appears once`).toBe(-1)
    last = at
  }
  expect(norm(report.pages[report.pages.length - 1].text)).toContain(`Page ${report.pages.length} of ${report.pages.length}`)
  expect(report.links).toContain('https://example.com/manual')
  expect(report.fonts.some((f) => f.endsWith('+LiberationSans'))).toBe(true)
  expect(report.fonts.some((f) => f.endsWith('+DejaVuSansMono'))).toBe(true)

  // Redaction: no magenta pixel anywhere in any image in the file; the redacted area is solid black.
  const rgbImages = report.images.filter((i) => !i.isMask)
  expect(rgbImages.length).toBeGreaterThanOrEqual(2)
  for (const img of rgbImages) expect(countColor(img, [255, 0, 255], 60), `image ${img.obj} has no magenta`).toBe(0)
  const shot = rgbImages.find((i) => countColor(i, [0x6e, 0xe7, 0xb7], 12) > 2000)!
  expect(shot, 'the screenshot is in the PDF').toBeTruthy()
  expect([shot.width, shot.height]).toEqual([480, 280])
  expect(pixelAt(shot, 350, 65)).toEqual([0, 0, 0])
  expect(pixelAt(shot, 300, 40)).toEqual([0, 0, 0])
  expect(pixelAt(shot, 399, 89)).toEqual([0, 0, 0])
  // The stored original is never embedded: no PNG file, and no run of its bytes.
  expect(containsBytes(report.bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
  const png = new Uint8Array(originalPng)
  expect(containsBytes(report.bytes, png.subarray(Math.floor(png.length / 2), Math.floor(png.length / 2) + 48))).toBe(false)

  // The note and its attachments are unchanged by exporting.
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByTestId('pdf-export')).toBeHidden()
  expect(await storedState(page, title)).toEqual(before)
  await expect(page.locator('.obj-image .markup-view')).toBeVisible()
})

async function openProjectNote(page: Page, project: string, note: string) {
  await page.getByTestId('rail-projects').click()
  const back = page.getByRole('button', { name: /All projects/ })
  if (await back.isVisible()) await back.click()
  await page.locator('.navigator').getByRole('button', { name: new RegExp(project) }).click()
  await page.locator('.navigator').getByRole('button', { name: new RegExp(note) }).click()
  await expect(page.getByLabel('Page title')).toHaveValue(note)
}

test('project note PDF: a wide table drawn in full, a label over a screenshot, A4 landscape in dark colours; a read-only window and an imported draft export too', async ({ page, context }, testInfo) => {
  await page.goto('/')
  await page.getByTestId('rail-projects').click()
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill('Lift Station 7')
  await page.getByLabel('Project name').press('Tab')
  await page.getByRole('button', { name: 'New project note' }).click()
  const title = 'LS7 I/O list'
  await page.getByLabel('Page title').fill(title)

  // A 30-column table in a 600 px text box is wider than the box (it scrolls on screen).
  const cols = Array.from({ length: 30 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`)
  const vals = cols.map((c) => c.replace('C', 'V'))
  const table = `<table><tbody><tr>${cols.map((c) => `<th><p>${c}</p></th>`).join('')}</tr><tr>${vals.map((v) => `<td><p>${v}</p></td>`).join('')}</tr></tbody></table>`
  await pasteClipboard(page, { 'text/html': `<p>I/O summary</p>${table}`, 'text/plain': 'I/O summary' })
  await expect(page.locator('.obj-text table th')).toHaveCount(30)
  expect(await page.locator('.obj-text .tableWrapper').evaluate((el) => el.scrollWidth > el.clientWidth + 10)).toBe(true)

  // A screenshot with a text label placed over it (the label is on top).
  await pasteScreenshot(page, 'HMI LS7', { w: 600, h: 320 })
  await expect(page.locator('.obj-image img')).toHaveCount(1)
  const img = await geometry(page.locator('.obj-image'))
  await page.keyboard.press('Escape')
  const label = await addTextBox(page, 'OVERLAY LABEL')
  await page.keyboard.press('Escape')
  await page.getByLabel('X position or size in pixels').fill(String(img.x + 40))
  await page.getByLabel('X position or size in pixels').press('Enter')
  await page.getByLabel('Y position or size in pixels').fill(String(img.y + 160))
  await page.getByLabel('Y position or size in pixels').press('Enter')
  await expect.poll(async () => (await geometry(label)).y).toBe(img.y + 160)
  await waitSaved(page)

  await page.getByTestId('export-pdf').click()
  const dialog = page.getByTestId('pdf-export')
  await dialog.getByRole('combobox', { name: 'Paper size' }).selectOption('a4')
  await dialog.getByRole('combobox', { name: 'Orientation' }).selectOption('landscape')
  await dialog.getByRole('combobox', { name: 'Colours' }).selectOption('dark')
  const { report, notes } = await exportPdf(page, testInfo, 'project.pdf')
  expect(notes).toContain('A4 paper, landscape')
  expect(notes).toContain('wider than the box')
  for (const p of report.pages) expect([Math.round(p.width), Math.round(p.height)]).toEqual([842, 595])
  const all = norm(report.pages.map((p) => p.text).join(' '))
  for (const s of [title, 'I/O summary', 'OVERLAY LABEL']) expect(all, s).toContain(s)
  // 30 columns at their 25 px minimum: on screen (and so in the PDF) each cell wraps one
  // character per line. Every character is there, in reading order.
  const squashed = all.replace(/\s+/g, '')
  expect(squashed).toContain(cols.join(''))
  expect(squashed).toContain(vals.join(''))
  // Nothing is cut off: every piece of text lies inside the printable area.
  for (const p of report.pages) {
    for (const it of p.items) {
      expect(it.x, it.str).toBeGreaterThanOrEqual(36 - 1)
      expect(it.x + it.width, it.str).toBeLessThanOrEqual(p.width - 36 + 1)
      expect(it.y, it.str).toBeGreaterThan(0)
      expect(it.y, it.str).toBeLessThan(p.height)
    }
  }
  // Dark colours: each sheet is filled with the page colour first.
  expect(report.raw).toContain('0.078 0.106 0.102 rg 0 0 841.89 595.28 re f')
  // Stacking order: the screenshot is drawn before the label that sits on it.
  const sheet = report.pages.find((p) => p.text.includes('OVERLAY'))!
  const imageAt = sheet.ops.findIndex((o) => o.kind === 'image')
  const labelAt = sheet.ops.findIndex((o) => o.kind === 'text' && o.text.includes('OVERLAY'))
  expect(imageAt).toBeGreaterThanOrEqual(0)
  expect(imageAt).toBeLessThan(labelAt)
  await dialog.getByRole('button', { name: 'Close' }).click()

  // A second window is read-only; it can still export (nothing is written).
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByTestId('readonly-banner')).toBeVisible()
  await openProjectNote(second, 'Lift Station 7', title)
  await second.getByTestId('export-pdf').click()
  const fromReadOnly = await exportPdf(second, testInfo, 'readonly.pdf')
  expect(norm(fromReadOnly.report.pages.map((p) => p.text).join(' '))).toContain('OVERLAY LABEL')
  expect(fromReadOnly.report.pages.length).toBe(report.pages.length)
  await second.close()

  // An imported PDF draft in the project exports like any note.
  await page.locator('.navigator [data-testid=import-file]').first().setInputFiles({ name: 'LS7 control narrative.pdf', mimeType: 'application/pdf', buffer: Buffer.from(makeTechnicalPdf()) })
  await expect(page.getByLabel('Page title')).toHaveValue('LS7 control narrative')
  await page.getByTestId('export-pdf').click()
  const draft = await exportPdf(page, testInfo, 'draft.pdf')
  expect(draft.notes).toContain('editable draft of “LS7 control narrative.pdf”')
  const draftText = norm(draft.report.pages.map((p) => p.text).join(' '))
  for (const s of ['Lift Station 7 Control Narrative', 'balance run hours', 'Alarm Checks', 'pump fail alarm latches']) expect(draftText, s).toContain(s)
  await waitSaved(page)
})

test('edge cases: an empty note, a screenshot taller than a sheet, emoji, photo metadata, and exporting offline', async ({ page, context }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('offline-pill')).toHaveText(/Offline ready/)

  // Empty note: one sheet with the title.
  await newQuickNote(page)
  await page.getByLabel('Page title').fill('Nothing here yet')
  await page.getByTestId('export-pdf').click()
  const empty = await exportPdf(page, testInfo, 'empty.pdf')
  expect(empty.report.pages.length).toBe(1)
  expect(norm(empty.report.pages[0].text)).toContain('Nothing here yet')
  expect(norm(empty.report.pages[0].text)).toContain('This page is empty.')
  await page.getByTestId('pdf-export').getByRole('button', { name: 'Close' }).click()

  // A tall screenshot (480 × 2400): split across sheets, no rows lost or repeated.
  await newQuickNote(page)
  await page.getByLabel('Page title').fill('Long trend screenshot')
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 480
    c.height = 2400
    const g = c.getContext('2d')!
    for (let y = 0; y < 2400; y += 100) {
      g.fillStyle = y % 200 === 0 ? '#1d4ed8' : '#16a34a'
      g.fillRect(0, y, 480, 100)
    }
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await page.getByTestId('page-surface').focus()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.locator('.obj-image img')).toHaveCount(1)
  // Emoji and other characters the PDF font lacks are drawn as pictures.
  await addTextBox(page, 'Status ✅ pump OK 😀 done')
  await page.keyboard.press('Escape')
  // A JPEG photo carrying a metadata segment (like camera GPS data) that must not reach the PDF.
  const jpeg = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 200
    const g = c.getContext('2d')!
    g.fillStyle = '#b45309'
    g.fillRect(0, 0, 320, 200)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const note = new TextEncoder().encode('Exif\0\0SECRET-GPS-49.2827N-123.1207W')
    const seg = new Uint8Array(4 + note.length)
    seg.set([0xff, 0xe1, (note.length + 2) >> 8, (note.length + 2) & 0xff])
    seg.set(note, 4)
    return Array.from(new Uint8Array([...bytes.subarray(0, 2), ...seg, ...bytes.subarray(2)]))
  })
  await page.locator('input[type=file][accept^="image/"]').setInputFiles({ name: 'site photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg) })
  await expect(page.locator('.obj-image img')).toHaveCount(2)
  await waitSaved(page)

  // Offline (the export code and its fonts come from the offline cache).
  await context.setOffline(true)
  await page.reload()
  await page.getByRole('button', { name: 'Inbox' }).click()
  await page.locator('.nav-page', { hasText: 'Long trend screenshot' }).click()
  await expect(page.locator('.obj-image img')).toHaveCount(2)
  await page.getByTestId('export-pdf').click()
  const { report, notes } = await exportPdf(page, testInfo, 'edge.pdf')
  await context.setOffline(false)
  expect(notes).toContain('1 picture taller than the space on a sheet is split across sheets')
  expect(notes).toMatch(/2 words use characters the PDF font does not include/)
  const text = norm(report.pages.map((p) => p.text).join(' '))
  for (const s of ['Status', 'pump OK', 'done']) expect(text, s).toContain(s)
  // The tall screenshot: pieces of the full width whose heights add up to the whole picture.
  const pieces = report.images.filter((i) => !i.isMask && i.width === 480 && countColor(i, [0x1d, 0x4e, 0xd8], 8) + countColor(i, [0x16, 0xa3, 0x4a], 8) === i.width * i.height)
  expect(pieces.length).toBeGreaterThanOrEqual(3)
  expect(pieces.reduce((n, i) => n + i.height, 0)).toBe(2400)
  // Bands of colour continue exactly across the cut (no rows lost or repeated).
  let y = 0
  for (const piece of pieces) {
    for (let row = 0; row < piece.height; row += 50) {
      const expected = Math.floor((y + row) / 100) % 2 === 0 ? [0x1d, 0x4e, 0xd8] : [0x16, 0xa3, 0x4a]
      const got = pixelAt(piece, 10, row)
      expect(Math.abs(got[0] - expected[0]) + Math.abs(got[1] - expected[1]) + Math.abs(got[2] - expected[2]), `row ${y + row}`).toBeLessThan(12)
    }
    y += piece.height
  }
  // The photo is re-encoded from its pixels: in the PDF as a JPEG, without the metadata.
  expect(report.images.some((i) => i.filter === 'DCT' && i.width === 320 && i.height === 200)).toBe(true)
  expect(report.raw).not.toContain('SECRET-GPS')
  expect(report.raw).not.toContain('Exif')
})

test('damaged and missing image files become placeholders; right-to-left words and emoji sequences are drawn as pictures', async ({ page }, testInfo) => {
  await page.goto('/')
  await newQuickNote(page)
  await page.getByLabel('Page title').fill('Damaged files')
  await addTextBox(page, 'Hebrew שלום Arabic مرحبا family 👨‍👩‍👧 end')
  await page.keyboard.press('Escape')
  await pasteScreenshot(page, 'ONE', { w: 300, h: 160 })
  await pasteScreenshot(page, 'TWO', { w: 300, h: 160 })
  await expect(page.locator('.obj-image img')).toHaveCount(2)
  await waitSaved(page)
  // Simulate damage outside the app: one image's bytes replaced with garbage, the other's deleted.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('minty-notes')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const req = db.transaction('blobs').objectStore('blobs').getAllKeys()
      req.onsuccess = () => resolve(req.result)
    })
    const tx = db.transaction('blobs', 'readwrite')
    tx.objectStore('blobs').put(new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' }), keys[0])
    tx.objectStore('blobs').delete(keys[1])
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  })
  await page.getByTestId('export-pdf').click()
  const { report, notes } = await exportPdf(page, testInfo, 'damaged.pdf')
  expect(notes).toContain('1 image file could not be read')
  expect(notes).toContain('1 image file is missing')
  expect(notes).toMatch(/3 words use characters the PDF font does not include, or a script it cannot shape/)
  const text = norm(report.pages.map((p) => p.text).join(' '))
  for (const s of ['Hebrew', 'Arabic', 'family', 'end', 'Image not available']) expect(text, s).toContain(s)
  expect(text).not.toContain('שלום') // drawn as a picture, not as unshaped text
  // Only small word pictures are embedded (no screenshot pixels exist to embed).
  for (const img of report.images.filter((i) => !i.isMask)) expect(img.height).toBeLessThan(100)
})
