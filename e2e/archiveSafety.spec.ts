import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { centralRecord, deflatedEntry, rawEntriesOf, rawZip, storedEntry } from '../src/test/rawZip'
import { addTextBox, dumpWorkspace, expectNothingChanged, newQuickNote, waitSaved } from './helpers'

/**
 * Archive safety in real Chromium (production build): hostile and genuine
 * backups through Settings → Restore, genuine and malformed Word documents
 * through Import document, and a genuine Word original inside a project
 * package. Hostile files are made in Node; genuine ones are the files in
 * src/test/files and the Word documents that ship with mammoth. Every browser
 * context is a separate, empty workspace.
 */

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MiB = 1024 * 1024
const BACKUPS = 'src/test/files/backups/'
const WORD_TABLES = 'node_modules/mammoth/test/test-data/tables.docx'
const LIBREOFFICE = 'src/test/files/docx/libreoffice-24.2.docx'

/** The audited file: 138 bytes whose directory lists word/document.xml at byte 1,048,576. */
const auditedDocx = () => rawZip([{ ...storedEntry('word/document.xml', strToU8('<w:d/>')), offset: 1_048_576 }])

/** The package with its Word original replaced by `fake`, and the manifest, the record, and every checksum updated to match. */
function withWordOriginal(good: Buffer, fake: Uint8Array): Buffer {
  const files = unzipSync(good) as Record<string, Uint8Array>
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { records: { path: string; size: number; sha256: string }; files: { attachmentId: string; path: string; size: number; sha256: string }[] }
  const records = JSON.parse(strFromU8(files['project.json'])) as { attachments: { id: string; mimeType: string; size: number; sha256: string }[] }
  const meta = records.attachments.find((a) => a.mimeType === DOCX_TYPE)!
  const listed = manifest.files.find((f) => f.attachmentId === meta.id)!
  files[listed.path] = fake
  meta.size = listed.size = fake.byteLength
  meta.sha256 = listed.sha256 = sha(fake)
  files['project.json'] = strToU8(JSON.stringify(records))
  manifest.records = { path: 'project.json', size: files['project.json'].byteLength, sha256: sha(files['project.json']) }
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  const out: Zippable = {}
  for (const [name, data] of Object.entries(files)) out[name] = [data, { level: name.startsWith('attachments/') ? 0 : 6 }]
  return Buffer.from(zipSync(out))
}

async function restoreFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('restore-file').setInputFiles(file)
  return page.getByRole('dialog')
}

test('hostile backups are refused by Restore before anything is unpacked, and the workspace stays exactly as it was', async ({ page }) => {
  await page.goto('/')
  await newQuickNote(page)
  await addTextBox(page, 'Still here after every refused backup')
  await waitSaved(page)
  const before = await dumpWorkspace(page)

  const good = readFileSync(`${BACKUPS}minty-0.4.1-backup.zip`)
  const entries = rawEntriesOf(new Uint8Array(good))
  const records = entries.find((e) => e.name === 'records.json')!
  const cases: [string, Uint8Array, RegExp][] = [
    // The two audited shapes: duplicate compressed manifests, and sizes that lie (16 bytes declared, 16 MiB inside).
    ['eight-manifests.zip', rawZip(Array.from({ length: 8 }, () => deflatedEntry('manifest.json', new Uint8Array(256 * 1024)))), /contains the file "manifest\.json" more than once/],
    ['forged-sizes.zip', rawZip([{ ...deflatedEntry('manifest.json', new Uint8Array(8 * MiB)), size: 8 }, { ...deflatedEntry('records.json', new Uint8Array(8 * MiB)), size: 8 }]), /"manifest\.json" unpacks to more than the backup records for it/],
    ['outside.zip', rawZip(entries.map((e) => (e === records ? { ...e, offset: 10_000_000 } : e))), /"records\.json" points outside the file/],
    ['contradicting.zip', rawZip(entries.map((e) => (e === records ? { ...e, local: { size: 3 } } : e))), /the two records of "records\.json" contradict each other/],
    ['overlapping.zip', rawZip(entries, (offsets) => [...entries.map((e, i) => centralRecord(e, offsets[i])), centralRecord({ ...records, name: 'attachments/x.png' }, offsets[entries.indexOf(records)])]), /contradict each other|overlap/],
    ['traversal.zip', rawZip([...entries, storedEntry('../../evil.txt', strToU8('x'))]), /unsafe file path \("\.\.\/\.\.\/evil\.txt"\)/],
    ['cut-off.zip', new Uint8Array(good.subarray(0, good.length - 40)), /damaged or incomplete/],
  ]
  for (const [name, bytes, reason] of cases) {
    const dialog = await restoreFile(page, { name, mimeType: 'application/zip', buffer: Buffer.from(bytes) })
    await expect(dialog.getByText('This backup cannot be restored. Nothing was changed.'), name).toBeVisible()
    await expect(dialog, name).toContainText(reason)
    await expect(dialog.getByRole('button', { name: 'Replace workspace' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
  }
  const after = await dumpWorkspace(page)
  expect(expectNothingChanged(before, after)).toBe(0)
  expect(after.revision).toBe(before.revision)
})

test('backups written by every release since 0.1.0, and backups zipped again by ZIP tools, restore in the browser', async ({ page }) => {
  test.setTimeout(180_000)
  page.on('dialog', (d) => void d.accept())
  await page.goto('/')
  const files = readdirSync(BACKUPS).filter((f) => f.endsWith('.zip')).sort()
  expect(files).toHaveLength(13)
  for (const name of files) {
    const dialog = await restoreFile(page, `${BACKUPS}${name}`)
    await expect(dialog.getByTestId('restore-review'), name).toContainText('passed every check')
    await dialog.getByRole('button', { name: 'Replace workspace' }).click()
    await expect(dialog.getByText(/^Restored /), name).toBeVisible()
    await dialog.getByRole('button', { name: 'Done' }).click()
    // The note, its text, and its screenshot are back.
    await page.getByRole('button', { name: 'Inbox' }).click()
    await page.locator('.nav-page', { hasText: 'VFD fault codes' }).click()
    await expect(page.locator('.obj-text'), name).toContainText('Remember the VFD fault code F0071')
    await expect(page.locator('.obj-image img'), name).toBeVisible()
  }
})

test('Word documents written by Word and LibreOffice import and preview; the audited malformed container is refused', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Inbox' }).click()
  const importInto = (name: string, bytes: Uint8Array) => page.getByTestId('import-file').first().setInputFiles({ name, mimeType: DOCX_TYPE, buffer: Buffer.from(bytes) })

  // Microsoft Word's own ZIP layout (deflate option flags, padding fields in the headers).
  await importInto('Word tables.docx', readFileSync(WORD_TABLES))
  await expect(page.getByLabel('Page title')).toHaveValue('Word tables')
  const draft = page.locator('.page')
  await expect(draft.locator('table td', { hasText: 'Top left' })).toHaveCount(1)
  await expect(draft).toContainText('Below')
  await page.getByTestId('import-banner').getByRole('button', { name: 'Preview original' }).click()
  await expect(page.getByTestId('preview-docx')).toContainText('Bottom right')
  await page.getByTestId('original-preview').getByRole('button', { name: 'Close' }).click()

  // LibreOffice's layout (data descriptors after every part).
  await page.getByRole('button', { name: 'Inbox' }).click()
  await importInto('Pump procedure.docx', readFileSync(LIBREOFFICE))
  await expect(page.getByLabel('Page title')).toHaveValue('Pump procedure')
  await expect(draft.locator('h1', { hasText: 'Pump Station 3' })).toHaveCount(1)
  await expect(draft.locator('strong', { hasText: 'procedure' })).toHaveCount(1)
  await expect(draft.locator('table td', { hasText: 'P101_RUN' })).toHaveCount(1)
  await page.getByTestId('import-banner').getByRole('button', { name: 'Preview original' }).click()
  await expect(page.getByTestId('preview-docx')).toContainText('Local:1:I.Data.0')
  await page.getByTestId('original-preview').getByRole('button', { name: 'Close' }).click()
  await waitSaved(page)

  // The audited container: refused with the reason, nothing stored.
  const before = await dumpWorkspace(page)
  await page.getByRole('button', { name: 'Inbox' }).click()
  await importInto('Audited.docx', auditedDocx())
  await expect(page.locator('.notice-error').last()).toContainText('“Audited.docx” is not a readable .docx file ("word/document.xml" points outside the file).')
  const after = await dumpWorkspace(page)
  expect(expectNothingChanged(before, after)).toBe(0)
  expect(after.revision).toBe(before.revision)
})

test('a Word original travels in a project package, arrives byte for byte, and still previews', async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000)
  const word = readFileSync(WORD_TABLES)
  await page.goto('/')
  await page.getByTestId('rail-projects').click()
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill('Word originals')
  await page.getByLabel('Project name').press('Tab')
  await page.locator('.navigator [data-testid=import-file]').first().setInputFiles({ name: 'Word tables.docx', mimeType: DOCX_TYPE, buffer: word })
  await expect(page.getByLabel('Page title')).toHaveValue('Word tables')
  await expect(page.getByTestId('import-banner')).toBeVisible()
  await waitSaved(page)

  // Export the project…
  await page.getByTestId('rail-projects').click()
  const back = page.getByRole('button', { name: /All projects/ })
  if (await back.isVisible()) await back.click()
  await page.locator('.navigator .nav-page', { has: page.locator('.nav-page-title', { hasText: /^Word originals$/ }) }).click()
  await expect(page.getByLabel('Project name')).toHaveValue('Word originals')
  await page.getByTestId('export-project').click()
  const exportDialog = page.getByTestId('project-export')
  await expect(exportDialog.getByTestId('export-summary')).toBeVisible()
  const download = page.waitForEvent('download')
  await exportDialog.getByTestId('export-download').click()
  const packagePath = testInfo.outputPath('word-originals.zip')
  await (await download).saveAs(packagePath)

  // …into another workspace. First a copy whose Word original was swapped for the audited 138-byte
  // container, with every size and checksum made to agree: refused, nothing written.
  const other = await browser.newContext()
  const b = await other.newPage()
  await b.goto('/')
  await b.getByTestId('rail-projects').click()
  const empty = await dumpWorkspace(b)
  await b.getByTestId('import-project-file').first().setInputFiles({ name: 'swapped.zip', mimeType: 'application/zip', buffer: withWordOriginal(readFileSync(packagePath), auditedDocx()) })
  const importDialog = b.getByTestId('project-import')
  await expect(importDialog.getByTestId('import-invalid')).toContainText('This file cannot be imported. Nothing in your workspace was changed.')
  await expect(importDialog.getByTestId('import-invalid')).toContainText('The file “Word tables.docx” is not the DOCX document it claims to be (it is not a readable Word file).')
  await importDialog.getByRole('button', { name: 'Close' }).click()
  expect(await dumpWorkspace(b)).toEqual(empty)
  // Then the real package.
  await b.getByTestId('import-project-file').first().setInputFiles(packagePath)
  await importDialog.getByTestId('import-confirm').click()
  await expect(importDialog.getByTestId('import-done')).toContainText('Imported “Word originals”')
  await importDialog.getByTestId('import-open').click()
  await b.locator('.navigator .nav-page', { hasText: 'Word tables' }).click()
  const banner = b.getByTestId('import-banner')
  await expect(banner).toContainText('Word tables.docx')
  const original = b.waitForEvent('download')
  await banner.getByRole('button', { name: 'Download original' }).click()
  const originalPath = testInfo.outputPath('original.docx')
  await (await original).saveAs(originalPath)
  expect(sha(readFileSync(originalPath))).toBe(sha(word))
  await banner.getByRole('button', { name: 'Preview original' }).click()
  await expect(b.getByTestId('preview-docx')).toContainText('Top right')
  await other.close()
})
