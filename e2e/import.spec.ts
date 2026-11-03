import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { makeDocx, makePdf, makeTechnicalPdf } from '../src/test/docFixtures'
import { waitSaved } from './helpers'

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

async function importInto(page: Page, name: string, mimeType: string, bytes: Uint8Array) {
  await page.getByTestId('import-file').first().setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) })
}

/** Every object starts below the bottom of the one before it (no overlapping sections). */
async function expectStacked(page: Page) {
  const boxes = await page.locator('.page .obj').evaluateAll((els) =>
    els.map((el) => ({ top: parseFloat((el as HTMLElement).style.top), bottom: parseFloat((el as HTMLElement).style.top) + (el as HTMLElement).offsetHeight })).sort((a, b) => a.top - b.top),
  )
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom)
}

test('DOCX import: sanitized editable draft, pictures, notes, original preview and download, search, reload, backup and clean restore', async ({ page, browser }, testInfo) => {
  const docx = makeDocx()
  await page.goto('/')
  await page.getByRole('button', { name: 'Inbox' }).click()
  await importInto(page, 'Pump station 3 procedure.docx', DOCX_TYPE, docx)

  // The draft opens with a banner naming the original.
  await expect(page.getByLabel('Page title')).toHaveValue('Pump station 3 procedure')
  const banner = page.getByTestId('import-banner')
  await expect(banner).toContainText('Imported draft')
  await expect(banner).toContainText('Pump station 3 procedure.docx')
  await expect(banner).toContainText('Word document')
  await expect(banner).toContainText('The original file is kept unchanged')

  // Structure and formatting survive; unsafe content does not.
  const draft = page.locator('.page')
  await expect(draft.locator('h1').first()).toHaveText('Pump Station 3 — Commissioning Procedure')
  await expect(draft.locator('h1', { hasText: 'Scope' })).toHaveCount(1)
  await expect(draft.locator('h2', { hasText: 'I/O list' })).toHaveCount(1)
  await expect(draft.locator('strong', { hasText: 'VTScada' })).toHaveCount(1)
  await expect(draft.locator('em', { hasText: 'Studio 5000' })).toHaveCount(1)
  await expect(draft.locator('u', { hasText: 'Never' })).toHaveCount(1)
  await expect(draft.locator('a[href="https://example.com/manual"]')).toHaveText('vendor manual')
  await expect(draft.locator('a[href^="javascript"]')).toHaveCount(0)
  await expect(draft).toContainText('this bad link') // the text stays, the link does not
  await expect(draft).toContainText('<script>window.__pwned = true</script> is shown as text')
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined()
  await expect(draft.locator('ul li')).toHaveCount(2)
  await expect(draft.locator('table tr')).toHaveCount(3)
  await expect(draft.locator('td[colspan="50"]')).toHaveText('Spare (merged)') // a 9999-column span is bounded
  await expect(draft.locator('.obj-image img')).toHaveCount(1) // the PNG; the EMF is reported instead
  await expectStacked(page)

  const notes = page.getByTestId('import-notes')
  await notes.locator('summary').click()
  await expect(notes).toContainText('format browsers cannot show')
  await expect(notes).toContainText('Page layout')

  // The draft is an ordinary editable note.
  await draft.locator('.obj-text p', { hasText: 'End of procedure.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Signed off by J.')
  await expect(draft).toContainText('End of procedure. Signed off by J.')
  await waitSaved(page)

  // Original preview (read-only conversion of the stored file, independent of the edit) and download.
  await banner.getByRole('button', { name: 'Preview original' }).click()
  const preview = page.getByTestId('original-preview')
  await expect(preview.getByTestId('preview-docx')).toContainText('Commissioning Procedure')
  await expect(preview.getByTestId('preview-docx')).not.toContainText('Signed off by J.')
  await expect(preview.locator('a[href^="javascript"]')).toHaveCount(0)
  await preview.getByRole('button', { name: 'Close' }).click()
  await expect(preview).toBeHidden()
  const dl = page.waitForEvent('download')
  await banner.getByRole('button', { name: 'Download original' }).click()
  const download = await dl
  expect(download.suggestedFilename()).toBe('Pump station 3 procedure.docx')
  const downloaded = testInfo.outputPath('original.docx')
  await download.saveAs(downloaded)
  expect(sha(readFileSync(downloaded))).toBe(sha(docx))

  // Search finds the converted text and the original's file name.
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('searchbox', { name: 'Search' }).fill('interlocks')
  await expect(page.getByTestId('search-results')).toContainText('Pump station 3 procedure')
  await page.getByRole('searchbox', { name: 'Search' }).fill('procedure.docx')
  await expect(page.getByTestId('search-results')).toContainText('Attachment')

  // Reload, then full backup → restore into a clean browser context.
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  const backupDl = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('import-backup.zip')
  await (await backupDl).saveAs(backupPath)
  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fresh = await clean.newPage()
  await fresh.goto('/')
  await fresh.getByRole('button', { name: 'Settings' }).click()
  await fresh.getByTestId('restore-file').setInputFiles(backupPath)
  await expect(fresh.getByTestId('restore-review')).toContainText('passed every check')
  await fresh.getByRole('button', { name: 'Replace workspace' }).click()
  await fresh.getByRole('button', { name: 'Done' }).click()
  await fresh.getByRole('button', { name: 'Inbox' }).click()
  await fresh.locator('.nav-page', { hasText: 'Pump station 3 procedure' }).click()
  await expect(fresh.getByTestId('import-banner')).toContainText('Pump station 3 procedure.docx')
  await expect(fresh.locator('.page')).toContainText('End of procedure. Signed off by J.')
  await expect(fresh.locator('.page .obj-image img')).toHaveCount(1)
  const dl2 = fresh.waitForEvent('download')
  await fresh.getByTestId('import-banner').getByRole('button', { name: 'Download original' }).click()
  const restoredPath = testInfo.outputPath('restored-original.docx')
  await (await dl2).saveAs(restoredPath)
  expect(sha(readFileSync(restoredPath))).toBe(sha(docx))
  await clean.close()
})

test('PDF import works offline: text draft, headings and bullets, honest notes, page preview', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByTestId('offline-pill')).toContainText('Offline ready', { timeout: 30_000 })
  await context.setOffline(true)
  await page.reload()

  // Into a notebook section (the converter files come from the offline cache).
  await page.getByRole('button', { name: 'Notebooks' }).click()
  await page.getByRole('button', { name: 'New notebook' }).click()
  await page.getByLabel('Notebook name').fill('Narratives')
  await page.getByLabel('Notebook name').press('Enter')
  await page.getByRole('button', { name: 'Import document into General' }).click() // opens the file chooser…
  await page.keyboard.press('Escape')
  await page.locator('.row-actions [data-testid=import-file]').first().setInputFiles({ name: 'LS7 control narrative.pdf', mimeType: 'application/pdf', buffer: Buffer.from(makeTechnicalPdf({ script: true })) })

  await expect(page.getByLabel('Page title')).toHaveValue('LS7 control narrative')
  await expect(page.locator('.crumbs')).toContainText('Narratives › General')
  const draft = page.locator('.page')
  await expect(draft.locator('.obj-text')).toHaveCount(2) // pages 1 and 2; page 3 has no text
  await expect(draft.locator('h2', { hasText: 'Lift Station 7 Control Narrative' })).toHaveCount(1)
  await expect(draft.locator('h3', { hasText: 'Alarm Checks' })).toHaveCount(1)
  await expect(draft).toContainText('The standby pump is alternated every cycle to balance run hours across both pumps.')
  await expect(draft.locator('ul li')).toHaveCount(2)
  await expectStacked(page)

  const notes = page.getByTestId('import-notes')
  await notes.locator('summary').click()
  await expect(notes).toContainText('Page 3 has no selectable text')
  await expect(notes).toContainText('OCR')
  await expect(notes).toContainText('Pictures and drawings on page 2')
  await expect(notes).toContainText('scripts. They were not run')
  await expect(notes).toContainText('Tables, columns, and exact layout are not reconstructed')

  // Page-by-page preview of the stored PDF (drawn locally with PDF.js).
  await page.getByTestId('import-banner').getByRole('button', { name: 'Preview original' }).click()
  const preview = page.getByTestId('original-preview')
  await expect(preview.getByTestId('preview-page')).toHaveText('Page 1 of 3')
  const canvas = preview.getByTestId('preview-canvas')
  await expect.poll(() => canvas.evaluate((c) => {
    const el = c as HTMLCanvasElement
    const data = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 100) dark++
    return dark
  })).toBeGreaterThan(200)
  await preview.getByRole('button', { name: 'Next ›' }).click()
  await expect(preview.getByTestId('preview-page')).toHaveText('Page 2 of 3')
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
  await waitSaved(page)
})

test('malformed, unsupported, and scanned files are refused or kept only when asked', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Inbox' }).click()
  const pages = page.locator('.nav-page')
  const before = await pages.count()

  // Not a document at all: refused with a reason, nothing stored.
  await importInto(page, 'notes.docx', DOCX_TYPE, new TextEncoder().encode('just some text'))
  await expect(page.locator('.notice-error').last()).toContainText('not a .docx or PDF')
  await importInto(page, 'legacy.doc', 'application/msword', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))
  await expect(page.locator('.notice-error').last()).toContainText('older Word (.doc)')
  await importInto(page, 'photos.docx', DOCX_TYPE, makeDocxLikeZip())
  await expect(page.locator('.notice-error').last()).toContainText('not a Word document')
  await expect(pages).toHaveCount(before)

  // A damaged PDF: the user is asked; declining stores nothing.
  const damaged = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> garbage without xref')
  page.once('dialog', (d) => {
    expect(d.message()).toContain('could not be converted')
    expect(d.message()).toContain('Keep the original file')
    void d.dismiss()
  })
  await importInto(page, 'damaged.pdf', 'application/pdf', damaged)
  await expect(page.locator('.notice').last()).toContainText('Nothing was imported')
  await expect(pages).toHaveCount(before)

  // A scanned PDF (no text layer): kept as the original only, with an explanation, when the user agrees.
  const scanned = makePdf([new TextEncoder().encode('0.2 0.2 0.2 rg 72 72 400 600 re f\n')])
  page.once('dialog', (d) => {
    expect(d.message()).toContain('no selectable text')
    void d.accept()
  })
  await importInto(page, 'scanned drawing.pdf', 'application/pdf', scanned)
  await expect(page.getByLabel('Page title')).toHaveValue('scanned drawing')
  await expect(page.getByTestId('import-banner')).toContainText('scanned drawing.pdf')
  await expect(page.locator('.page .obj-text')).toContainText('Text recognition (OCR) is not available')
  await expect(pages).toHaveCount(before + 1)
  await page.getByTestId('import-banner').getByRole('button', { name: 'Preview original' }).click()
  await expect(page.getByTestId('preview-page')).toHaveText('Page 1 of 1')
  await page.keyboard.press('Escape')
  await waitSaved(page)
})

/** A ZIP that is not a Word document (no word/document.xml). */
function makeDocxLikeZip(): Uint8Array {
  // Minimal stored ZIP with one file "a.txt" ("hi").
  const name = new TextEncoder().encode('a.txt')
  const data = new TextEncoder().encode('hi')
  const crc = 0xd8932aac
  const local = new Uint8Array(30 + name.length + data.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint32(14, crc, true)
  lv.setUint32(18, data.length, true)
  lv.setUint32(22, data.length, true)
  lv.setUint16(26, name.length, true)
  local.set(name, 30)
  local.set(data, 30 + name.length)
  const central = new Uint8Array(46 + name.length)
  const cv = new DataView(central.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(4, 20, true)
  cv.setUint16(6, 20, true)
  cv.setUint32(16, crc, true)
  cv.setUint32(20, data.length, true)
  cv.setUint32(24, data.length, true)
  cv.setUint16(28, name.length, true)
  central.set(name, 46)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, central.length, true)
  ev.setUint32(16, local.length, true)
  const out = new Uint8Array(local.length + central.length + end.length)
  out.set(local, 0)
  out.set(central, local.length)
  out.set(end, local.length + central.length)
  return out
}

test('a long DOCX becomes several stacked text sections without freezing the page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Inbox' }).click()
  const started = Date.now()
  await importInto(page, 'Long manual.docx', DOCX_TYPE, makeDocx({ extraParagraphs: 1200 }))
  await expect(page.getByLabel('Page title')).toHaveValue('Long manual')
  expect(Date.now() - started).toBeLessThan(30_000)
  expect(await page.locator('.page .obj-text').count()).toBeGreaterThan(20)
  await expect(page.locator('.page')).toContainText('Extra paragraph 1200:')
  await expectStacked(page)
  // The page stays responsive: typing lands immediately.
  await page.locator('.page .obj-text p', { hasText: 'Extra paragraph 1200:' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' (checked)')
  await expect(page.locator('.page')).toContainText('lorem ipsum dolor sit amet, consectetur adipiscing elit. (checked)')
  await waitSaved(page)
})
