import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { makeTechnicalPdf } from '../src/test/docFixtures'
import { deflatedEntry, rawEntriesOf, rawZip, storedEntry } from '../src/test/rawZip'
import { addTextBox, dumpWorkspace, expectNothingChanged, imageHash, pasteScreenshot, waitSaved } from './helpers'

/**
 * Portable project export/import in real Chromium (production build), with
 * synthetic data only. Each browser context is a separate, empty workspace:
 * nothing here touches a real Chrome profile.
 */

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')

async function allProjects(page: Page) {
  await page.getByTestId('rail-projects').click()
  const back = page.getByRole('button', { name: /All projects/ })
  if (await back.isVisible()) await back.click()
}

async function newProject(page: Page, name: string) {
  await allProjects(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(name)
  await page.getByLabel('Project name').press('Tab')
}

async function openProject(page: Page, name: string, tab: 'overview' | 'tasks' | 'files' = 'overview') {
  await allProjects(page)
  await page
    .locator('.navigator .nav-page')
    .filter({ has: page.locator('.nav-page-title', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) })
    .click()
  await expect(page.getByLabel('Project name')).toHaveValue(name)
  await page.getByTestId(`tab-${tab}`).click()
}

async function libraryPage(page: Page, title: string, text: string) {
  await page.getByTestId('rail-notebooks').click()
  await page.getByRole('button', { name: 'Add starter notebooks' }).click()
  await page.getByRole('button', { name: 'Add page to General' }).first().click() // VTScada › General
  await page.getByLabel('Page title').fill(title)
  await addTextBox(page, text)
  await expect(page.locator('.chip-inherited')).toHaveText('VTScada')
}

const card = (page: Page, title: string) => page.getByTestId('task-card').filter({ hasText: title })
const column = (page: Page, status: 'todo' | 'doing' | 'done') => page.getByTestId(`column-${status}`)

async function addTask(page: Page, title: string) {
  await page.getByLabel('New task title').fill(title)
  await page.getByLabel('New task title').press('Enter')
  await expect(card(page, title)).toBeVisible()
}

/** Open the export dialog for the open project, tick what is needed, and save the package. */
async function exportOpenProject(page: Page, path: string): Promise<string> {
  await page.getByTestId('export-project').click()
  const dialog = page.getByTestId('project-export')
  await expect(dialog.getByTestId('export-summary')).toBeVisible()
  const ack = dialog.getByTestId('export-understood')
  if (await ack.isVisible()) await ack.check()
  const download = page.waitForEvent('download')
  await dialog.getByTestId('export-download').click()
  const file = await download
  await file.saveAs(path)
  await expect(dialog.getByTestId('export-done')).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  return file.suggestedFilename()
}

async function chooseImport(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await allProjects(page)
  await page.getByTestId('import-project-file').first().setInputFiles(file)
  return page.getByTestId('project-import')
}

/** A package whose one picture was replaced by plain text, with the manifest, the record, and all checksums updated to match. */
function notAPicture(good: Buffer): Buffer {
  const files = unzipSync(good) as Record<string, Uint8Array>
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { records: { path: string; size: number; sha256: string }; files: { attachmentId: string; path: string; size: number; sha256: string }[] }
  const records = JSON.parse(strFromU8(files['project.json'])) as { attachments: { id: string; mimeType: string; size: number; sha256: string }[] }
  const meta = records.attachments.find((a) => a.mimeType === 'image/png')!
  const listed = manifest.files.find((f) => f.attachmentId === meta.id)!
  const fake = strToU8('<script>alert("not an image")</script> plain text presented as a PNG')
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

test('a project travels to another workspace: export, import beside unrelated projects, edit independently, back up and restore', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000)
  page.on('dialog', (d) => void d.accept())
  await page.goto('/')

  // ---------------------------------------------------------------- workspace A (the sender)
  await libraryPage(page, 'Alarm priority standard', 'Priority 1 = critical, page on-call')
  await waitSaved(page)
  // An unrelated project that must never travel.
  await newProject(page, 'Other customer job')
  await page.getByLabel('Customer').fill('Somebody Else Inc')
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('Page title').fill('Pricing')
  await addTextBox(page, 'CONFIDENTIAL-PRICING-9000')
  await waitSaved(page)

  await newProject(page, 'Lift Station 7 upgrade')
  await page.getByLabel('Customer').fill('City of Example (synthetic)')
  await page.getByLabel('Job number').fill('J-2207')
  await page.getByLabel('Add system category to project').fill('VTScada')
  await page.getByLabel('Add system category to project').press('Enter')
  await page.getByTestId('ref-suggested').getByRole('button', { name: 'Pin Alarm priority standard' }).click()
  await expect(page.getByTestId('ref-pinned')).toContainText('Alarm priority standard')

  // An imported PDF (the original file is kept with its draft).
  const pdf = makeTechnicalPdf()
  await page.locator('.navigator [data-testid=import-file]').first().setInputFiles({ name: 'LS7 control narrative.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) })
  await expect(page.getByLabel('Page title')).toHaveValue('LS7 control narrative')
  await expect(page.getByTestId('import-banner')).toBeVisible()

  // A project note: table, link to the imported draft, code, link to the library page, marked-up screenshot, sketch.
  await page.getByRole('button', { name: 'New project note' }).click()
  await page.getByLabel('Page title').fill('Commissioning notes')
  const box = await addTextBox(page, 'Pump I/O')
  await page.getByRole('button', { name: /Insert table/ }).click()
  for (const cell of ['Tag', 'Address', 'State', 'P101_RUN', 'Local:1:I.Data.0', 'OK']) {
    await page.keyboard.type(cell)
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await page.getByRole('group', { name: 'Table rows and columns' }).getByRole('button', { name: 'Delete row' }).click()
  await expect(box.locator('table tr')).toHaveCount(2)
  await box.locator('td').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('Narrative: [[LS7')
  await page.keyboard.press('Enter')
  await expect(box.locator('a.page-link')).toHaveText('LS7 control narrative')
  await page.keyboard.type(' and standard: [[Alarm pri')
  await page.keyboard.press('Enter')
  await expect(box.locator('a.page-link')).toHaveText(['LS7 control narrative', 'Alarm priority standard'])
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Code block (Ctrl+Alt+C)' }).click()
  await page.keyboard.type('IF LSH_101 THEN Start_Lag := 1; END_IF;')
  await page.keyboard.press('Escape')

  await pasteScreenshot(page, 'HMI LS7 10.20.30.40', { w: 600, h: 320 })
  const image = page.locator('.obj-image')
  await expect(image.locator('img')).toHaveCount(1)
  const screenshotHash = await imageHash(image.locator('img'))
  await image.click()
  await page.getByRole('button', { name: /^Mark up:/ }).click()
  const svg = page.locator('.markup-svg')
  const r = (await svg.boundingBox())!
  const at = (x: number, y: number) => page.mouse.move(r.x + r.width * x, r.y + r.height * y, { steps: 4 })
  await at(0.2, 0.7)
  await page.mouse.down()
  await at(0.5, 0.4)
  await page.mouse.up()
  await page.keyboard.press('x') // redaction box
  await at(0.6, 0.1)
  await page.mouse.down()
  await at(0.9, 0.3)
  await page.mouse.up()
  await page.getByTestId('markup-done').click()
  await expect(image.locator('.markup-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Add a sketch/ }).click()
  await expect(page.locator('.markup-stage')).toBeFocused()
  await page.keyboard.press('l')
  await page.keyboard.press('Enter')
  await page.keyboard.press('t')
  await page.keyboard.press('Enter')
  await page.getByLabel('Label text').fill('LSH-101 → PLC DI 4')
  await page.getByLabel('Label text').press('Enter')
  await page.getByTestId('markup-done').click()
  await expect(page.locator('.obj-sketch')).toHaveCount(1)
  await waitSaved(page)
  const noteHtml = await page.locator('.obj-text .ProseMirror').first().innerHTML()
  const markupItems = await page.locator('.obj-image .markup-view').first().evaluate((el) => el.querySelectorAll('g.mk-item, rect.mk-item').length)

  // Files: a local path and a web link (references only).
  await openProject(page, 'Lift Station 7 upgrade', 'files')
  await page.getByRole('button', { name: 'Add local path' }).click()
  await page.getByLabel('Name of location 1').fill('Job folder')
  await page.getByLabel('Path of location 1').fill('D:\\Jobs\\J-2207')
  await page.getByLabel('Description of location 1').fill('PLC backups and drawings')
  await page.getByRole('button', { name: 'Add web link' }).click()
  await page.getByLabel('Name of location 2').fill('Dropbox share')
  await page.getByLabel('Link of location 2').fill('https://www.dropbox.com/scl/fo/synthetic/J-2207')

  // Tasks: three columns, a priority, a date-only due date, and links to a note and the reference.
  await page.getByTestId('tab-tasks').click()
  await addTask(page, 'Configure alarm list')
  await addTask(page, 'Historian tag check')
  await addTask(page, 'Factory acceptance test')
  await card(page, 'Configure alarm list').locator('.task-title-btn').click()
  const editor = page.getByTestId('task-editor')
  await editor.getByLabel('Task priority').selectOption('urgent')
  await editor.getByLabel('Task due date').fill('2026-12-15')
  await editor.getByLabel('Task details').fill('Map priorities per the standard')
  await editor.getByLabel('Find a note to link').fill('commissioning')
  await editor.locator('.pin-results').getByRole('button', { name: 'Link' }).click()
  await editor.getByLabel('Find a note to link').fill('alarm priority')
  await editor.locator('.pin-results').getByRole('button', { name: 'Link' }).click()
  await expect(editor.getByTestId('task-links')).toContainText('Alarm priority standard')
  await editor.getByRole('button', { name: 'Close' }).click()
  await card(page, 'Configure alarm list').locator('.task-title-btn').focus()
  await page.keyboard.press('Alt+ArrowRight')
  await expect(column(page, 'doing')).toContainText('Configure alarm list')
  await card(page, 'Historian tag check').getByRole('button', { name: 'Complete “Historian tag check”' }).click()
  await expect(column(page, 'done')).toContainText('Historian tag check')
  await waitSaved(page)

  // ---------------------------------------------------------------- export (A)
  const beforeExport = await dumpWorkspace(page)
  await page.getByTestId('tab-overview').click()
  await page.getByTestId('export-project').click()
  const exportDialog = page.getByTestId('project-export')
  await expect(exportDialog.getByTestId('export-notes')).toContainText('2 project notes, 1 sketch')
  await expect(exportDialog.getByTestId('export-tasks')).toContainText('3 tasks (1 done)')
  await expect(exportDialog.getByTestId('export-images')).toContainText('1 original image file')
  await expect(exportDialog.getByTestId('export-originals')).toContainText('1 original DOCX/PDF file')
  await expect(exportDialog.getByTestId('export-references')).toHaveText('1 page')
  await expect(exportDialog.getByTestId('export-locations')).toContainText('1 folder path and 1 web link — as text only. The files and folders they point to are not included.')
  await expect(exportDialog.locator('.transfer-list li', { hasText: 'Alarm priority standard' }).first()).toContainText('from VTScada › General · pinned to the project, linked from a project note, linked from a task')
  await expect(exportDialog.getByTestId('export-excluded')).toContainText('Other projects, the rest of your notebooks and library, templates, and the Trash.')
  // The privacy warning comes before the download, and the redacted screenshot needs an explicit yes.
  const privacy = exportDialog.getByTestId('export-privacy')
  await expect(privacy).toContainText('A project package is editable data, not a redacted document.')
  await expect(privacy).toContainText('original image files in full')
  await expect(exportDialog.getByTestId('export-covered')).toContainText('1 image in this project has a redaction, blur, or crop.')
  await expect(exportDialog.getByTestId('export-download')).toBeDisabled()
  // Leaving the reference out is reported, not silent.
  await exportDialog.getByTestId('export-pinned').uncheck()
  await expect(exportDialog.getByTestId('export-references')).toHaveText('1 page') // it is also linked from a note and a task
  await expect(exportDialog.locator('.transfer-list li', { hasText: 'Alarm priority standard' }).first()).toContainText('still included by another choice here')
  await exportDialog.getByTestId('export-linked').uncheck()
  await expect(exportDialog.getByTestId('export-references')).toHaveText('none')
  await expect(exportDialog.getByTestId('export-excluded')).toContainText('1 linked page outside the choices above')
  await expect(exportDialog.getByTestId('export-excluded')).toContainText('1 task link to pages that are not included')
  await exportDialog.getByTestId('export-pinned').check()
  await exportDialog.getByTestId('export-linked').check()
  await exportDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(exportDialog).toBeHidden()

  const packagePath = testInfo.outputPath('ls7-package.zip')
  const fileName = await exportOpenProject(page, packagePath)
  expect(fileName).toMatch(/^minty-project-Lift-Station-7-upgrade-\d{8}-\d{6}Z\.zip$/)

  // Exporting changed nothing in A: every record, every file, and the revision.
  const afterExport = await dumpWorkspace(page)
  expect(afterExport).toEqual(beforeExport)

  // The file itself (read in Node): a versioned package with only this project — and the unredacted original.
  const zip = unzipSync(readFileSync(packagePath))
  const manifest = JSON.parse(strFromU8(zip['manifest.json'])) as { format: string; packageVersion: number; formatVersion: number; counts: Record<string, number>; files: { path: string; sha256: string }[] }
  expect(manifest).toMatchObject({ format: 'minty-notes-project', packageVersion: 1, formatVersion: 4, counts: { notes: 2, references: 1, tasks: 3, attachments: 2 } })
  const projectJson = strFromU8(zip['project.json'])
  expect(projectJson).not.toContain('CONFIDENTIAL-PRICING-9000')
  expect(projectJson).not.toContain('Other customer job')
  expect(projectJson).not.toContain('Somebody Else Inc')
  expect(projectJson).toContain('Priority 1 = critical, page on-call')
  expect(manifest.files.map((f) => f.sha256).sort()).toEqual([screenshotHash, sha(pdf)].sort())
  expect(Object.keys(zip).filter((n) => n.startsWith('attachments/')).map((n) => sha(zip[n])).sort()).toEqual([screenshotHash, sha(pdf)].sort())

  // ---------------------------------------------------------------- workspace B (the receiver), with its own data
  const receiver = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const b = await receiver.newPage()
  b.on('dialog', (d) => void d.accept())
  await b.goto('/')
  await libraryPage(b, 'Alarm priority standard', 'RECEIVER-OWN-STANDARD-TEXT') // same title, its own page
  await waitSaved(b)
  await newProject(b, 'Lift Station 7 upgrade') // same name as the incoming project
  await b.getByLabel('Customer').fill('Receiver’s own customer')
  await b.getByRole('button', { name: 'New note', exact: true }).click()
  await b.getByLabel('Page title').fill('Commissioning notes')
  await addTextBox(b, 'RECEIVER-OWN-NOTE-TEXT')
  await openProject(b, 'Lift Station 7 upgrade', 'tasks')
  await addTask(b, 'Receiver’s own task')
  await waitSaved(b)
  const beforeImport = await dumpWorkspace(b)

  // ---------------------------------------------------------------- import (B)
  const importDialog = await chooseImport(b, packagePath)
  const review = importDialog.getByTestId('import-review')
  await expect(review).toContainText('The package passed every check')
  await expect(importDialog.getByTestId('import-name')).toContainText('Lift Station 7 upgrade (imported)')
  await expect(importDialog.getByTestId('import-name')).toContainText('a project named “Lift Station 7 upgrade” is already here')
  await expect(importDialog.getByTestId('import-notes-count')).toHaveText('2 project notes, 1 sketch')
  await expect(importDialog.getByTestId('import-tasks')).toHaveText('3 tasks (1 done)')
  await expect(importDialog.getByTestId('import-images')).toContainText('1 image')
  await expect(importDialog.getByTestId('import-originals')).toHaveText('1 original DOCX/PDF file')
  await expect(importDialog.getByTestId('import-reference-list')).toContainText('Alarm priority standard · was in VTScada › General')
  await expect(importDialog.getByTestId('import-categories')).toHaveText('VTScada (already here)')
  await expect(importDialog.getByTestId('import-covered')).toContainText('The package contains the full original image')
  await expect(importDialog.getByTestId('import-promise')).toContainText('Nothing that is already in this workspace is replaced or changed')
  await expect(importDialog.getByTestId('import-reuse')).toHaveCount(0) // another workspace: nothing to "reuse"
  // Nothing has been written yet.
  expect(await dumpWorkspace(b)).toEqual(beforeImport)
  await importDialog.getByTestId('import-confirm').click()
  await expect(importDialog.getByTestId('import-done')).toContainText('Imported “Lift Station 7 upgrade (imported)”: 2 notes, 1 reference copy, 3 tasks, and 2 files.')
  await importDialog.getByTestId('import-open').click()
  await expect(b.getByLabel('Project name')).toHaveValue('Lift Station 7 upgrade (imported)')

  // Everything that was in B is exactly as it was; the import added records and one revision.
  const afterImport = await dumpWorkspace(b)
  expect(expectNothingChanged(beforeImport, afterImport)).toBeGreaterThan(10)
  expect(afterImport.revision).toBe(beforeImport.revision + 1)
  expect(Object.values(afterImport.blobs)).toEqual(expect.arrayContaining([screenshotHash, sha(pdf)]))
  // No record of A kept its ID.
  for (const store of Object.keys(beforeExport.records)) for (const id of Object.keys(beforeExport.records[store])) expect(afterImport.records[store][id], `${store} ${id}`).toBeUndefined()

  // Both projects are in the list, side by side.
  await allProjects(b)
  await expect(b.locator('.navigator .nav-page-title')).toHaveText(['Lift Station 7 upgrade', 'Lift Station 7 upgrade (imported)'])

  // ---- the imported project's content
  await openProject(b, 'Lift Station 7 upgrade (imported)')
  await expect(b.getByLabel('Customer')).toHaveValue('City of Example (synthetic)')
  await expect(b.getByLabel('Job number')).toHaveValue('J-2207')
  // The receiver's own same-titled library page is suggested by category (as for any project) — not linked or changed.
  await expect(b.getByTestId('ref-pinned')).toHaveCount(0)
  await expect(b.getByTestId('ref-suggested')).toContainText('Alarm priority standard')
  await b.locator('.navigator .nav-page', { hasText: 'Commissioning notes' }).click()
  await expect(b.locator('.crumbs')).toContainText('Lift Station 7 upgrade (imported)')
  await expect(b.locator('.obj-text table tr')).toHaveCount(2)
  await expect(b.locator('.obj-text pre')).toContainText('Start_Lag := 1;')
  // Same text and structure; only the page IDs inside the links differ.
  const stripIds = (html: string) => html.replace(/data-page-id="[^"]*"/g, 'data-page-id=""')
  expect(stripIds(await b.locator('.obj-text .ProseMirror').first().innerHTML())).toBe(stripIds(noteHtml))
  await expect(b.locator('.obj-image .markup-view')).toBeVisible()
  expect(await b.locator('.obj-image .markup-view').first().evaluate((el) => el.querySelectorAll('g.mk-item, rect.mk-item').length)).toBe(markupItems)
  await expect(b.locator('.obj-sketch .markup-view text')).toContainText('LSH-101 → PLC DI 4')

  // Page links lead to the imported pages: the narrative draft with its original…
  const links = b.locator('.obj-text a.page-link')
  await links.nth(0).click({ modifiers: ['ControlOrMeta'] })
  await expect(b.getByLabel('Page title')).toHaveValue('LS7 control narrative')
  await expect(b.locator('.crumbs')).toContainText('Lift Station 7 upgrade (imported)')
  await expect(b.getByTestId('import-banner')).toContainText('LS7 control narrative.pdf')
  await expect(b.getByTestId('page-backlinks')).toContainText('Commissioning notes')
  const original = b.waitForEvent('download')
  await b.getByTestId('import-banner').getByRole('button', { name: 'Download original' }).click()
  const originalPath = testInfo.outputPath('original.pdf')
  await (await original).saveAs(originalPath)
  expect(sha(readFileSync(originalPath))).toBe(sha(pdf))
  await b.getByTestId('import-banner').getByRole('button', { name: 'Preview original' }).click()
  await expect(b.getByTestId('preview-page')).toHaveText('Page 1 of 3')
  await b.keyboard.press('Escape')
  await b.getByTestId('link-back').click()
  // …and the reference snapshot (the sender's text), not the receiver's own page with the same title.
  await links.nth(1).click({ modifiers: ['ControlOrMeta'] })
  await expect(b.getByLabel('Page title')).toHaveValue('Alarm priority standard')
  await expect(b.getByTestId('copy-banner')).toContainText('Independent copy of “Alarm priority standard”')
  await expect(b.getByTestId('copy-banner')).toContainText('this page came with an imported project')
  await expect(b.locator('.obj-text')).toHaveText('Priority 1 = critical, page on-call')
  await expect(b.locator('.crumbs')).toContainText('Lift Station 7 upgrade (imported) › Notes')

  // Tasks: columns, priority, due date, and links to the imported pages.
  await openProject(b, 'Lift Station 7 upgrade (imported)', 'tasks')
  await expect(b.getByTestId('task-card')).toHaveCount(3)
  await expect(column(b, 'doing')).toContainText('Configure alarm list')
  await expect(column(b, 'done')).toContainText('Historian tag check')
  await expect(column(b, 'todo')).toContainText('Factory acceptance test')
  await expect(card(b, 'Configure alarm list').locator('.prio-urgent')).toHaveText(/Urgent/)
  await card(b, 'Configure alarm list').locator('.task-title-btn').click()
  const bEditor = b.getByTestId('task-editor')
  await expect(bEditor.getByLabel('Task due date')).toHaveValue('2026-12-15')
  await expect(bEditor.getByLabel('Task details')).toHaveValue('Map priorities per the standard')
  await expect(bEditor.getByTestId('task-links')).toContainText('Commissioning notes')
  await expect(bEditor.getByTestId('task-links')).toContainText('Alarm priority standard')
  await bEditor.getByTestId('task-links').getByRole('button', { name: /^Alarm priority standard/ }).click()
  await expect(b.getByTestId('copy-banner')).toBeVisible() // the task's link is the snapshot too
  await expect(b.locator('.obj-text')).toHaveText('Priority 1 = critical, page on-call')

  // Files: the saved locations came along as text.
  await openProject(b, 'Lift Station 7 upgrade (imported)', 'files')
  await expect(b.getByLabel('Path of location 1')).toHaveValue('D:\\Jobs\\J-2207')
  await expect(b.getByLabel('Description of location 1')).toHaveValue('PLC backups and drawings')
  await expect(b.getByTestId('file-item').nth(1).getByRole('link')).toHaveAttribute('href', 'https://www.dropbox.com/scl/fo/synthetic/J-2207')

  // The receiver's own project and library page are untouched and still separate.
  await openProject(b, 'Lift Station 7 upgrade')
  await expect(b.getByLabel('Customer')).toHaveValue('Receiver’s own customer')
  await b.locator('.navigator .nav-page', { hasText: 'Commissioning notes' }).click()
  await expect(b.locator('.obj-text')).toHaveText('RECEIVER-OWN-NOTE-TEXT')

  // ---------------------------------------------------------------- independence: edit the copy in B, reload both
  await openProject(b, 'Lift Station 7 upgrade (imported)')
  await b.locator('.navigator .nav-page', { hasText: 'Commissioning notes' }).click()
  await b.getByLabel('Page title').fill('Commissioning notes (receiver edit)')
  await addTextBox(b, 'Added by the receiver')
  await openProject(b, 'Lift Station 7 upgrade (imported)', 'tasks')
  await card(b, 'Factory acceptance test').getByRole('button', { name: 'Complete “Factory acceptance test”' }).click()
  await waitSaved(b)
  await b.reload()
  await expect(column(b, 'done')).toContainText('Factory acceptance test')
  await b.locator('.navigator .nav-page', { hasText: 'Commissioning notes (receiver edit)' }).click()
  await expect(b.locator('.obj-text').filter({ hasText: 'Added by the receiver' })).toHaveCount(1)
  await expect(b.locator('.obj-image .markup-view')).toBeVisible()
  // A is exactly as it was when it exported (also after a reload).
  await page.reload()
  await expect(page.getByLabel('Project name')).toHaveValue('Lift Station 7 upgrade')
  expect(await dumpWorkspace(page)).toEqual(beforeExport)
  await page.locator('.navigator .nav-page', { hasText: 'Commissioning notes' }).click()
  await expect(page.getByLabel('Page title')).toHaveValue('Commissioning notes')
  await expect(page.locator('.obj-text').filter({ hasText: 'Added by the receiver' })).toHaveCount(0)

  // ---------------------------------------------------------------- a full backup of B restores into a clean workspace C
  await b.getByRole('button', { name: 'Settings' }).click()
  await waitSaved(b)
  const afterEdits = await dumpWorkspace(b)
  const backupDownload = b.waitForEvent('download')
  await b.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('receiver-backup.zip')
  await (await backupDownload).saveAs(backupPath)
  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const c = await clean.newPage()
  await c.goto('/')
  await c.getByRole('button', { name: 'Settings' }).click()
  await c.getByTestId('restore-file').setInputFiles(backupPath)
  await expect(c.getByTestId('restore-review')).toContainText('passed every check')
  await c.getByRole('button', { name: 'Replace workspace' }).click()
  await c.getByRole('button', { name: 'Done' }).click()
  const restored = await dumpWorkspace(c)
  expect(restored.records).toEqual(afterEdits.records)
  expect(restored.blobs).toEqual(afterEdits.blobs)
  await openProject(c, 'Lift Station 7 upgrade (imported)', 'tasks')
  await expect(c.getByTestId('task-card')).toHaveCount(3)
  await c.locator('.navigator .nav-page', { hasText: 'Commissioning notes (receiver edit)' }).click()
  await c.locator('.obj-text a.page-link').first().click({ modifiers: ['ControlOrMeta'] })
  await expect(c.getByTestId('import-banner')).toContainText('LS7 control narrative.pdf')
  // A project package is not a backup: the restore screen says so and changes nothing.
  await c.getByRole('button', { name: 'Settings' }).click()
  await c.getByTestId('restore-file').setInputFiles(packagePath)
  await expect(c.getByRole('alert')).toContainText('portable project package, not a full workspace backup')
  await c.getByRole('button', { name: 'Close' }).click()
  expect((await dumpWorkspace(c)).records).toEqual(afterEdits.records)

  await clean.close()
  await receiver.close()
})

test('import refuses bad files and failed writes without changing the workspace; read-only windows cannot import; export and import work offline', async ({ page, context }, testInfo) => {
  test.setTimeout(150_000)
  page.on('dialog', (d) => void d.accept())
  await page.goto('/')
  await expect(page.getByTestId('offline-pill')).toHaveText(/Offline ready/)
  await newProject(page, 'Booster station')
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('Page title').fill('Site notes')
  await addTextBox(page, 'VFD fault F0021 after power dip')
  await page.getByTestId('page-surface').click({ position: { x: 900, y: 900 } })
  await pasteScreenshot(page, 'VFD KEYPAD')
  await expect(page.locator('.obj-image img')).toBeVisible()
  await waitSaved(page)

  // ---- offline: export, then import the same file into this workspace
  await context.setOffline(true)
  await page.reload()
  await openProject(page, 'Booster station')
  const packagePath = testInfo.outputPath('booster.zip')
  await page.getByTestId('export-project').click()
  // No redaction in this project: the warning is shown, but no extra confirmation is needed.
  await expect(page.getByTestId('export-privacy')).toContainText('not a redacted document')
  await expect(page.getByTestId('export-understood')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await exportOpenProject(page, packagePath)
  const original = await dumpWorkspace(page)
  let dialog = await chooseImport(page, packagePath)
  await expect(dialog.getByTestId('import-name')).toContainText('Booster station (imported)')
  await dialog.getByTestId('import-confirm').click()
  await expect(dialog.getByTestId('import-done')).toContainText('Imported “Booster station (imported)”: 1 note, 0 reference copies, 0 tasks, and 1 file.')
  await dialog.getByRole('button', { name: 'Close' }).click()
  const state = await dumpWorkspace(page)
  expect(expectNothingChanged(original, state)).toBe(5) // project, page, text box, image object, attachment record
  expect(Object.keys(state.blobs)).toHaveLength(2)
  await context.setOffline(false)

  // ---- files that are not a valid package: refused with a reason, nothing changes
  const good = readFileSync(packagePath)
  const repacked = (mutate: (files: Record<string, Uint8Array>, manifest: Record<string, unknown>) => void) => {
    const files = unzipSync(good) as Record<string, Uint8Array>
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
    mutate(files, manifest)
    files['manifest.json'] = strToU8(JSON.stringify(manifest))
    const out: Zippable = {}
    for (const [name, data] of Object.entries(files)) out[name] = [data, { level: name.startsWith('attachments/') ? 0 : 6 }]
    return Buffer.from(zipSync(out))
  }
  const damaged = Buffer.from(good)
  damaged.fill(0x41, 120, 400)
  const cases: [string, Buffer, RegExp][] = [
    ['not-a-zip.zip', Buffer.from('this is plain text, not a package at all'), /not a Minty Notes project package \(it is not a ZIP archive\)/],
    ['cut-off.zip', good.subarray(0, Math.floor(good.length * 0.6)), /list of files is damaged or was cut off/],
    ['damaged.zip', damaged, /checksum|could not be unpacked|contradict each other|damaged/],
    ['newer.zip', repacked((_f, m) => void (m.packageVersion = 2)), /newer version of Minty Notes.*Update the app/],
    ['extra-file.zip', repacked((f) => void (f['setup.exe'] = strToU8('MZ'))), /a file Minty Notes did not put there \("setup.exe"\)/],
    ['traversal.zip', repacked((f) => void (f['../../evil.txt'] = strToU8('x'))), /unsafe file path/],
    ['missing-image.zip', repacked((f) => void delete f[Object.keys(f).find((n) => n.startsWith('attachments/'))!]), /is missing from the package/],
    ['edited.zip', repacked((f) => void (f['project.json'] = strToU8(strFromU8(f['project.json']).replace('Booster station', 'Tampered station')))), /project.json does not match its checksum/],
    // Hostile archives (hand-made): refused from the ZIP's list of files, before anything is unpacked.
    ['eight-manifests.zip', Buffer.from(rawZip(Array.from({ length: 8 }, () => deflatedEntry('manifest.json', new Uint8Array(256 * 1024))))), /"manifest.json" more than once/],
    ['forged-size.zip', Buffer.from(rawZip([{ ...storedEntry('manifest.json', new Uint8Array(9 * 1024 * 1024).fill(0x20)), size: 1 }, ...rawEntriesOf(good).filter((e) => e.name !== 'manifest.json')])), /sizes recorded for "manifest.json" contradict each other/],
    ['swollen-data.zip', Buffer.from(rawZip(rawEntriesOf(good).map((e) => (e.name === 'project.json' ? { ...deflatedEntry('project.json', new Uint8Array(20 * 1024 * 1024).fill(0x20)), size: e.size } : e)))), /"project.json" unpacks to more than the package records for it/],
    // A picture that is not a picture, with every size and checksum made to agree.
    ['not-a-picture.zip', notAPicture(good), /is not the PNG picture it claims to be/],
  ]
  for (const [name, buffer, reason] of cases) {
    dialog = await chooseImport(page, { name, mimeType: 'application/zip', buffer })
    const invalid = dialog.getByTestId('import-invalid')
    await expect(invalid, name).toContainText('This file cannot be imported. Nothing in your workspace was changed.')
    await expect(invalid, name).toContainText(reason)
    await expect(dialog.getByTestId('import-confirm')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
  }
  // A full workspace backup is not a project package.
  await page.getByRole('button', { name: 'Settings' }).click()
  const backupDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('backup.zip')
  await (await backupDownload).saveAs(backupPath)
  dialog = await chooseImport(page, backupPath)
  await expect(dialog.getByTestId('import-invalid')).toContainText('full workspace backup, not a project package')
  await dialog.getByRole('button', { name: 'Close' }).click()
  expect((await dumpWorkspace(page)).records).toEqual(state.records)

  // ---- a write that fails in the middle of the import (simulated: the browser refuses a write, as when the disk is full)
  await page.evaluate(() => {
    const w = window as unknown as { __realAdd?: IDBObjectStore['add'] }
    w.__realAdd = IDBObjectStore.prototype.add
    let calls = 0
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (++calls === 3) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      return w.__realAdd!.apply(this, args)
    }
  })
  dialog = await chooseImport(page, packagePath)
  await expect(dialog.getByTestId('import-name')).toContainText('Booster station (imported 2)')
  await dialog.getByTestId('import-confirm').click()
  await expect(dialog.getByTestId('import-failed')).toContainText('The project was not imported, and nothing in your workspace was changed.')
  await expect(dialog.getByTestId('import-failed')).toContainText('run out of storage space')
  const afterFailure = await dumpWorkspace(page)
  expect(afterFailure.records).toEqual(state.records)
  expect(afterFailure.blobs).toEqual(state.blobs)
  expect(afterFailure.revision).toBe(state.revision)
  await expect(page.locator('.navigator .nav-page-title')).toHaveText(['Booster station', 'Booster station (imported)'])
  // When storage works again, "Try again" imports it.
  await page.evaluate(() => {
    const w = window as unknown as { __realAdd: IDBObjectStore['add'] }
    IDBObjectStore.prototype.add = w.__realAdd
  })
  await dialog.getByTestId('import-confirm').click()
  await expect(dialog.getByTestId('import-done')).toContainText('Imported “Booster station (imported 2)”')
  await dialog.getByTestId('import-open').click()
  await expect(page.getByLabel('Project name')).toHaveValue('Booster station (imported 2)')
  await page.locator('.navigator .nav-page', { hasText: 'Site notes' }).click()
  await expect(page.locator('.obj-text')).toHaveText('VFD fault F0021 after power dip')
  await expect.poll(() => page.locator('.obj-image img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await allProjects(page) // no page open: nothing is re-measured and saved behind the comparison below
  await waitSaved(page)
  const beforeSecond = await dumpWorkspace(page)

  // ---- a second window is read-only: it can export (it only reads) but has no way to import
  const second = await context.newPage()
  second.on('dialog', (d) => void d.accept())
  await second.goto('/')
  await expect(second.getByTestId('readonly-banner')).toBeVisible()
  await allProjects(second)
  await expect(second.locator('.navigator .nav-page-title')).toHaveCount(3)
  expect((await second.locator('.navigator .nav-page-title').allTextContents()).sort()).toEqual(['Booster station', 'Booster station (imported 2)', 'Booster station (imported)'].sort())
  await expect(second.getByTestId('import-project')).toHaveCount(0)
  await expect(second.getByTestId('import-project-file')).toHaveCount(0)
  await openProject(second, 'Booster station')
  const secondPath = testInfo.outputPath('from-read-only.zip')
  await exportOpenProject(second, secondPath)
  expect(Object.keys(unzipSync(readFileSync(secondPath))).sort()).toEqual(Object.keys(unzipSync(good)).sort())
  expect(await dumpWorkspace(second)).toEqual(beforeSecond)
  // The read-only window follows what the editing window imports.
  dialog = await chooseImport(page, secondPath)
  await dialog.getByTestId('import-confirm').click()
  await expect(dialog.getByTestId('import-done')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await allProjects(second)
  await expect(second.locator('.navigator .nav-page-title')).toHaveCount(4)
})

test('importing back into the workspace a project came from: independent copies by default, or links to the same library pages when asked', async ({ page }, testInfo) => {
  page.on('dialog', (d) => void d.accept())
  await page.goto('/')
  await libraryPage(page, 'Alarm priority standard', 'Priority 1 = critical, page on-call')
  await waitSaved(page)
  await newProject(page, 'Reservoir telemetry')
  await page.getByLabel('Add system category to project').fill('VTScada')
  await page.getByLabel('Add system category to project').press('Enter')
  await page.getByTestId('ref-suggested').getByRole('button', { name: 'Pin Alarm priority standard' }).click()
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('Page title').fill('Radio survey')
  await addTextBox(page, 'See [[Alarm pri')
  await page.keyboard.press('Enter')
  await expect(page.locator('.obj-text a.page-link')).toHaveText('Alarm priority standard')
  await page.keyboard.press('Escape')
  await pasteScreenshot(page, 'RSSI -71 dBm')
  await expect(page.locator('.obj-image img')).toBeVisible()
  await waitSaved(page)
  await openProject(page, 'Reservoir telemetry')
  const packagePath = testInfo.outputPath('reservoir.zip')
  await page.getByTestId('export-project').click()
  await expect(page.getByTestId('export-summary')).toBeVisible()
  await page.getByTestId('project-export').screenshot({ path: testInfo.outputPath('export-dialog.png') })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await exportOpenProject(page, packagePath)
  const before = await dumpWorkspace(page)

  // Default: an independent snapshot copy, even though the very same page is in this library.
  let dialog = await chooseImport(page, packagePath)
  const choice = dialog.getByTestId('import-reuse')
  await expect(choice).toContainText('1 reference page of this package is a page of this very library (“Alarm priority standard”)')
  await expect(choice.getByRole('radio').first()).toBeChecked()
  await dialog.screenshot({ path: testInfo.outputPath('import-review.png') })
  await dialog.getByTestId('import-confirm').click()
  await expect(dialog.getByTestId('import-done')).toContainText('Imported “Reservoir telemetry (imported)”: 1 note, 1 reference copy, 0 tasks, and 1 file.')
  await dialog.screenshot({ path: testInfo.outputPath('import-done.png') })
  await dialog.getByTestId('import-open').click()
  await page.locator('.navigator .nav-page', { hasText: 'Radio survey' }).click()
  await page.locator('.obj-text a.page-link').click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('copy-banner')).toBeVisible() // the snapshot, owned by the imported project
  await expect(page.locator('.crumbs')).toContainText('Reservoir telemetry (imported) › Notes')

  // On request: link the page that is already here instead of copying it.
  dialog = await chooseImport(page, packagePath)
  await dialog.getByTestId('import-reuse-existing').check()
  await dialog.getByTestId('import-confirm').click()
  await expect(dialog.getByTestId('import-done')).toContainText('Imported “Reservoir telemetry (imported 2)”: 1 note, 0 reference copies, 1 linked existing page, 0 tasks, and 1 file.')
  await dialog.getByTestId('import-open').click()
  await expect(page.getByTestId('ref-pinned')).toContainText('Alarm priority standard')
  await page.locator('.navigator .nav-page', { hasText: 'Radio survey' }).click()
  await page.locator('.obj-text a.page-link').click({ modifiers: ['ControlOrMeta'] })
  // The original library page itself: pinned by the source project and this one, and suggested by category in the first import.
  await expect(page.getByTestId('shared-banner')).toContainText('Shared page — linked in 3 projects')
  await expect(page.locator('.crumbs')).toContainText('Reservoir telemetry (imported 2) › References')
  await allProjects(page)
  await page.locator('.navigator').screenshot({ path: testInfo.outputPath('projects-list.png') })
  await waitSaved(page)
  // The library page and the original project were never changed by either import.
  expectNothingChanged(before, await dumpWorkspace(page))

  // What a refused file looks like.
  dialog = await chooseImport(page, { name: 'holiday-photos.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'beach.jpg': strToU8('not really a photo') })) })
  await expect(dialog.getByTestId('import-invalid')).toContainText('a file Minty Notes did not put there')
  await dialog.screenshot({ path: testInfo.outputPath('import-invalid.png') })
  await dialog.getByRole('button', { name: 'Close' }).click()
})

test('pages hidden for a project and pages of another project never get into its package, even when its notes link to them', async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000)
  page.on('dialog', (d) => void d.accept())
  await page.goto('/')

  // ---- a library with one page the project will pin and one it will hide; another project with a private note
  await libraryPage(page, 'Alarm priority standard', 'Priority 1 = critical, page on-call')
  await waitSaved(page)
  await page.getByTestId('rail-notebooks').click()
  await page.getByRole('button', { name: 'Add page to General' }).first().click()
  await page.getByLabel('Page title').fill('Legacy driver hint')
  await addTextBox(page, 'HIDDEN-LIBRARY-TEXT-777')
  await page.keyboard.press('Escape')
  await pasteScreenshot(page, 'HIDDEN SCREEN')
  await expect(page.locator('.obj-image img')).toBeVisible()
  await waitSaved(page)
  const hiddenImage = await imageHash(page.locator('.obj-image img'))
  await newProject(page, 'Other customer job')
  await page.getByLabel('Customer').fill('Somebody Else Inc')
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('Page title').fill('Pricing')
  await addTextBox(page, 'CONFIDENTIAL-PRICING-9000')
  await waitSaved(page)

  await newProject(page, 'Pump station 3')
  await page.getByLabel('Add system category to project').fill('VTScada')
  await page.getByLabel('Add system category to project').press('Enter')
  await page.getByTestId('ref-suggested').getByRole('button', { name: 'Pin Alarm priority standard' }).click()
  await page.getByTestId('ref-suggested').getByRole('button', { name: 'Hide Legacy driver hint' }).click()
  await expect(page.getByTestId('ref-suggested')).toHaveCount(0)
  // A note that links to all three: the pinned library page, the hidden page, and the other project's note.
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('Page title').fill('Site notes')
  await addTextBox(page, 'Standard: [[Alarm pri')
  await page.keyboard.press('Enter')
  await expect(page.locator('.obj-text a.page-link')).toHaveText(['Alarm priority standard'])
  await page.keyboard.type(' old driver: [[Legacy dr')
  await page.keyboard.press('Enter')
  await expect(page.locator('.obj-text a.page-link')).toHaveText(['Alarm priority standard', 'Legacy driver hint'])
  await page.keyboard.type(' prices: [[Pricing')
  await page.keyboard.press('Enter')
  await expect(page.locator('.obj-text a.page-link')).toHaveText(['Alarm priority standard', 'Legacy driver hint', 'Pricing'])
  await page.keyboard.press('Escape')
  await waitSaved(page)

  // ---- the export dialog names what stays out, whatever is ticked
  await openProject(page, 'Pump station 3')
  const before = await dumpWorkspace(page)
  await page.getByTestId('export-project').click()
  const dialog = page.getByTestId('project-export')
  await expect(dialog.getByTestId('export-references')).toHaveText('1 page')
  await expect(dialog.getByTestId('export-hidden')).toContainText('1 page hidden for this project — also where a note or task links to it.')
  const excluded = dialog.getByTestId('export-excluded-pages')
  await expect(excluded.locator('li', { hasText: 'Legacy driver hint' })).toContainText('hidden for this project · from VTScada › General · linked from a project note')
  await expect(excluded.locator('li', { hasText: 'Pricing' })).toContainText('belongs to another project · from Project: Other customer job · linked from a project note')
  await expect(excluded).toContainText('Links to these pages stay in the text and will show as unavailable after import')
  for (const group of ['pinned', 'linked', 'suggested']) await expect(dialog.locator('.transfer-group', { has: page.getByTestId(`export-${group}`) })).not.toContainText(/Legacy driver hint|Pricing/)
  await expect(dialog.getByTestId('export-suggested')).toBeDisabled() // nothing is left to suggest: the only other match is hidden
  await dialog.getByTestId('export-linked').uncheck()
  await dialog.getByTestId('export-pinned').uncheck()
  await expect(dialog.getByTestId('export-references')).toHaveText('none')
  await expect(excluded).toContainText('Legacy driver hint')
  await dialog.getByTestId('export-linked').check()
  await dialog.getByTestId('export-pinned').check()
  await expect(dialog.getByTestId('export-references')).toHaveText('1 page')
  await dialog.screenshot({ path: testInfo.outputPath('export-exclusions.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  const packagePath = testInfo.outputPath('pump-station-3.zip')
  await exportOpenProject(page, packagePath)
  expect(await dumpWorkspace(page)).toEqual(before)

  // ---- the downloaded file itself, read in Node: every file of the ZIP, and its raw bytes
  const bytes = readFileSync(packagePath)
  const zip = unzipSync(bytes)
  const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1')
  for (const [name, data] of Object.entries(zip)) {
    for (const secret of ['HIDDEN-LIBRARY-TEXT-777', 'CONFIDENTIAL-PRICING-9000', 'Other customer job', 'Somebody Else Inc']) expect(latin1(data).includes(secret), `${secret} in ${name}`).toBe(false)
  }
  const records = JSON.parse(strFromU8(zip['project.json'])) as { pages: { title: string }[]; attachments: unknown[]; references: { from: string }[]; project: { hiddenPageIds: string[]; pinnedPageIds: string[] } }
  expect(records.pages.map((p) => p.title).sort()).toEqual(['Alarm priority standard', 'Site notes'])
  expect(records.references.map((r) => r.from)).toEqual(['VTScada › General'])
  expect(records.project.hiddenPageIds).toEqual([])
  expect(records.project.pinnedPageIds).toHaveLength(1)
  // The hidden page's screenshot is in the workspace, and not in the package.
  expect(Object.values(before.blobs)).toContain(hiddenImage)
  expect(records.attachments).toEqual([])
  expect(Object.keys(zip).filter((n) => n.startsWith('attachments/'))).toEqual([])
  expect(Object.keys(zip).sort()).toEqual(['README.txt', 'manifest.json', 'project.json'])

  // ---- in another workspace the two links are unavailable; the eligible one opens the copied page
  const receiver = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const b = await receiver.newPage()
  b.on('dialog', (d) => void d.accept())
  await b.goto('/')
  const importDialog = await chooseImport(b, packagePath)
  await expect(importDialog.getByTestId('import-review')).toContainText('The package passed every check')
  await expect(importDialog.getByTestId('import-review')).toContainText('1 note links to 2 pages that were not included in the package')
  await importDialog.getByTestId('import-confirm').click()
  await expect(importDialog.getByTestId('import-done')).toContainText('Imported “Pump station 3”: 1 note, 1 reference copy, 0 tasks, and 0 files.')
  await importDialog.getByTestId('import-open').click()
  await b.locator('.navigator .nav-page', { hasText: 'Site notes' }).click()
  const links = b.locator('.obj-text a.page-link')
  await expect(links).toHaveText(['Alarm priority standard', 'Legacy driver hint', 'Pricing'])
  await expect(b.locator('.obj-text .page-link-missing')).toHaveText(['Legacy driver hint', 'Pricing'])
  await expect(b.locator('.obj-text .page-link-ok')).toHaveText(['Alarm priority standard'])
  await expect(b.locator('.obj-text .page-link-missing').first()).toHaveAttribute('title', /not included when this project was imported/)
  const imported = await dumpWorkspace(b)
  expect(JSON.stringify(imported.records)).not.toContain('HIDDEN-LIBRARY-TEXT-777')
  expect(JSON.stringify(imported.records)).not.toContain('CONFIDENTIAL-PRICING-9000')
  expect(Object.values(imported.blobs)).toEqual([])
  await links.nth(0).click({ modifiers: ['ControlOrMeta'] })
  await expect(b.getByLabel('Page title')).toHaveValue('Alarm priority standard')
  await expect(b.getByTestId('copy-banner')).toContainText('Independent copy of “Alarm priority standard”')
  await receiver.close()
})

test('the sidebar lists the notes of an imported project in the same sequence as the original', async ({ page, browser }, testInfo) => {
  page.on('dialog', (d) => void d.accept())
  await page.goto('/')
  await newProject(page, 'Ordered notes')
  const titles = ['Scope', 'Network', 'Alarms', 'Checklist']
  for (const title of titles) {
    await openProject(page, 'Ordered notes')
    await page.getByRole('button', { name: 'New note', exact: true }).click()
    await page.getByLabel('Page title').fill(title)
    await addTextBox(page, `${title} text`)
    await page.keyboard.press('Escape')
    await waitSaved(page)
  }
  // Edit an early note again, so the order is not simply the order of creation.
  await page.locator('.navigator .nav-page', { hasText: 'Network' }).click()
  await page.getByLabel('Page title').fill('Network (revised)')
  await waitSaved(page)
  await openProject(page, 'Ordered notes')
  const notesOf = (p: Page) => p.locator('.navigator .nav-list').nth(1).locator('.nav-page-title').allTextContents()
  const original = await notesOf(page)
  expect(original).toEqual(['Network (revised)', 'Checklist', 'Alarms', 'Scope'])
  const packagePath = testInfo.outputPath('ordered.zip')
  await exportOpenProject(page, packagePath)

  const receiver = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const b = await receiver.newPage()
  b.on('dialog', (d) => void d.accept())
  await b.goto('/')
  const dialog = await chooseImport(b, packagePath)
  await dialog.getByTestId('import-confirm').click()
  await dialog.getByTestId('import-open').click()
  await expect(b.getByLabel('Project name')).toHaveValue('Ordered notes')
  expect(await notesOf(b)).toEqual(original)
  // Also after the workspace is read from storage again.
  await b.reload()
  await openProject(b, 'Ordered notes')
  expect(await notesOf(b)).toEqual(original)
  await receiver.close()
})
