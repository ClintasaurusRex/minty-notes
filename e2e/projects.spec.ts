import { expect, test, type Page } from '@playwright/test'
import { addTextBox, imageHash, pasteScreenshot, waitSaved } from './helpers'

/** Put the caret at the end of the first text box and type. */
async function appendText(page: Page, text: string) {
  const editor = page.locator('.obj-text .ProseMirror').first()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

async function replaceText(page: Page, text: string) {
  const editor = page.locator('.obj-text .ProseMirror').first()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(text)
}

async function openProject(page: Page, name: string) {
  await page.getByTestId('rail-projects').click()
  const back = page.getByRole('button', { name: /All projects/ })
  if (await back.isVisible()) await back.click()
  await page.locator('.navigator').getByRole('button', { name: new RegExp(name.replace(/[()]/g, '\\$&')) }).click()
  await expect(page.getByLabel('Project name')).toHaveValue(name)
}

async function newProject(page: Page, name: string) {
  await page.getByTestId('rail-projects').click()
  const back = page.getByRole('button', { name: /All projects/ })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(name)
}

async function libraryPage(page: Page, title: string, text: string) {
  await page.getByTestId('rail-notebooks').click()
  await page.getByRole('button', { name: 'Add starter notebooks' }).click()
  // The first starter notebook is VTScada (with the VTScada category).
  await page.getByRole('button', { name: 'Add page to General' }).first().click()
  await page.getByLabel('Page title').fill(title)
  await addTextBox(page, text)
  await expect(page.locator('.crumbs')).toContainText('VTScada › General')
  await expect(page.locator('.chip-inherited')).toHaveText('VTScada')
}

test('one shared reference updates in two projects; a project copy stays independent', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('home')).toBeVisible()
  await libraryPage(page, 'Alarm setup', 'Alarm priorities: 1 critical')
  await waitSaved(page)

  // North gets the page as a category suggestion; South pins it explicitly.
  await newProject(page, 'North pump station')
  await page.getByLabel('Add system category to project').fill('VTScada')
  await page.getByLabel('Add system category to project').press('Enter')
  await expect(page.getByTestId('ref-suggested')).toContainText('Alarm setup')
  await newProject(page, 'South lift station')
  await page.getByLabel('Find a library page to pin').fill('alarm')
  await page.locator('.pin-results').getByRole('button', { name: 'Pin' }).click()
  await expect(page.getByTestId('ref-pinned')).toContainText('Alarm setup')
  await expect(page.getByTestId('ref-pinned')).toContainText('also linked in North pump station')

  // Edit the original once, from South.
  await page.getByTestId('ref-pinned').locator('.ref-open').click()
  await expect(page.getByTestId('shared-banner')).toContainText('linked in 2 projects')
  await expect(page.getByTestId('shared-banner')).toContainText('Edits here change it everywhere')
  await appendText(page, ' (rev B)')
  await waitSaved(page)

  // North shows the same, edited page.
  await openProject(page, 'North pump station')
  await page.getByTestId('ref-suggested').locator('.ref-open').click()
  await expect(page.locator('.crumbs')).toContainText('North pump station › References')
  await expect(page.locator('.obj-text')).toHaveText('Alarm priorities: 1 critical (rev B)')

  // Make an independent copy for North and change it.
  await page.getByTestId('shared-banner').getByRole('button', { name: 'Make a project copy' }).click()
  await expect(page.getByTestId('copy-banner')).toContainText('Independent copy of “Alarm setup”')
  await expect(page.locator('.crumbs')).toContainText('North pump station › Notes')
  await replaceText(page, 'North-only alarm list')
  await page.getByLabel('Add tag to this page').fill('alarms')
  await page.getByLabel('Add tag to this page').press('Enter')
  await expect(page.locator('.chip-tag')).toContainText('#alarms')
  await waitSaved(page)

  // Edit the original again from South: the copy must not change.
  await openProject(page, 'South lift station')
  await page.getByTestId('ref-pinned').locator('.ref-open').click()
  await appendText(page, ' + rev C')
  await waitSaved(page)
  await expect(page.locator('.obj-text')).toHaveText('Alarm priorities: 1 critical (rev B) + rev C')

  await openProject(page, 'North pump station')
  await expect(page.getByTestId('ref-suggested')).toHaveCount(0) // the original is hidden; North uses its copy
  await page.locator('.navigator').getByRole('button', { name: /Alarm setup/ }).click()
  await expect(page.getByTestId('copy-banner')).toBeVisible()
  await expect(page.locator('.obj-text')).toHaveText('North-only alarm list')

  // Both survive a reload.
  await page.reload()
  await expect(page.locator('.obj-text')).toHaveText('North-only alarm list')
  await expect(page.getByTestId('copy-banner')).toBeVisible()

  // Search: note text, tags, and a project filter.
  await page.getByTestId('rail-search').click()
  await page.getByLabel('Search', { exact: true }).fill('alarms')
  await expect(page.getByTestId('search-results')).toContainText('North pump station')
  await page.getByLabel('Search', { exact: true }).fill('rev C')
  const results = page.getByTestId('search-results')
  await expect(results.locator('li')).toHaveCount(1)
  await expect(results).toContainText('Reference page')
  await page.getByLabel('Project filter').selectOption({ label: 'North pump station' })
  await expect(page.getByText('No results.')).toBeVisible() // North no longer links the original
  await page.getByLabel('Project filter').selectOption({ label: 'South lift station' })
  await expect(results.locator('li')).toHaveCount(1)
  await results.locator('.result').click()
  await expect(page.getByTestId('shared-banner')).toBeVisible()
})

test('archive, trash, and delete keep shared pages; projects, links, tags, and images survive backup and restore', async ({ page, browser }, testInfo) => {
  await page.goto('/')
  await libraryPage(page, 'Panel wiring standard', 'Use ferrules on every conductor')
  await newProject(page, 'Plant upgrade')
  await page.getByLabel('Customer').fill('Example Water')
  await page.getByLabel('Job number').fill('J-3100')
  await page.getByLabel('Due date').fill('2026-12-15')
  await page.getByLabel('Add system category to project').fill('VTScada')
  await page.getByLabel('Add system category to project').press('Enter')
  await page.getByRole('button', { name: 'Add software' }).click()
  await page.getByLabel('Software 1').fill('VTScada')
  await page.getByLabel('Version 1').fill('12.1.40')
  await page.getByRole('button', { name: 'Add location' }).click()
  await page.getByLabel('Location name 1').fill('Job folder')
  await page.getByLabel('Path or link 1').fill('D:\\Dropbox\\Jobs\\J-3100')
  await expect(page.getByTestId('ref-suggested')).toContainText('Panel wiring standard')

  // A project note with a pasted screenshot and a tag.
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByLabel('Page title').fill('Site walk')
  await addTextBox(page, 'Cabinet 2 needs a new breaker')
  await page.getByTestId('page-surface').click({ position: { x: 900, y: 900 } })
  await pasteScreenshot(page, 'CABINET')
  await expect(page.locator('.obj-image img')).toBeVisible()
  await page.getByLabel('Add tag to this page').fill('punchlist')
  await page.getByLabel('Add tag to this page').press('Enter')
  await waitSaved(page)
  const hash = await imageHash(page.locator('.obj-image img'))

  // Archive hides it from Home and the current list; nothing is lost.
  await openProject(page, 'Plant upgrade')
  await page.getByRole('button', { name: 'Archive' }).click()
  await page.getByTestId('rail-home').click()
  await expect(page.getByTestId('project-tile')).toHaveCount(0)
  await page.getByTestId('rail-projects').click()
  await page.getByRole('button', { name: /All projects/ }).click()
  await expect(page.locator('.navigator')).not.toContainText('Plant upgrade')
  await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.locator('.navigator').getByRole('button', { name: /Plant upgrade/ }).click()
  await page.getByRole('button', { name: 'Unarchive' }).click()
  await page.getByTestId('rail-home').click()
  await expect(page.getByTestId('project-tile')).toContainText('Plant upgrade')
  await expect(page.getByTestId('project-tile')).toContainText('Example Water · J-3100')

  // Full backup, then restore into a clean browser profile.
  await page.getByTestId('rail-settings').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('stage2-backup.zip')
  await (await downloadPromise).saveAs(backupPath)

  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const fresh = await clean.newPage()
  await fresh.goto('/')
  await fresh.getByTestId('rail-settings').click()
  await fresh.getByTestId('restore-file').setInputFiles(backupPath)
  const review = fresh.getByTestId('restore-review')
  await expect(review).toContainText('passed every check')
  await expect(review.locator('dd').nth(1)).toHaveText('1') // projects
  await fresh.getByRole('button', { name: 'Replace workspace' }).click()
  await expect(fresh.getByText(/Restored 1 projects, 2 pages, and 1 images/)).toBeVisible()
  await fresh.getByRole('button', { name: 'Done' }).click()
  await openProject(fresh, 'Plant upgrade')
  await expect(fresh.getByLabel('Customer')).toHaveValue('Example Water')
  await expect(fresh.getByLabel('Due date')).toHaveValue('2026-12-15')
  await expect(fresh.getByLabel('Version 1')).toHaveValue('12.1.40')
  await expect(fresh.getByLabel('Path or link 1')).toHaveValue('D:\\Dropbox\\Jobs\\J-3100')
  await expect(fresh.getByTestId('ref-suggested')).toContainText('Panel wiring standard')
  await fresh.locator('.navigator').getByRole('button', { name: /Site walk/ }).click()
  await expect(fresh.locator('.obj-text')).toHaveText('Cabinet 2 needs a new breaker')
  await expect(fresh.locator('.chip-tag')).toContainText('#punchlist')
  expect(await imageHash(fresh.locator('.obj-image img'))).toBe(hash)
  await fresh.getByTestId('rail-search').click()
  await fresh.getByLabel('Search', { exact: true }).fill('punchlist')
  await expect(fresh.getByTestId('search-results')).toContainText('Site walk')
  await clean.close()

  // Trash, then delete forever: notes go to the page Trash; the shared page stays.
  page.on('dialog', (d) => void d.accept())
  await openProject(page, 'Plant upgrade')
  await page.getByTestId('project-view').getByRole('button', { name: 'Move to Trash' }).click()
  await page.getByTestId('rail-trash').click()
  await expect(page.getByRole('list', { name: 'Trashed projects' })).toContainText('Plant upgrade')
  await page.getByRole('list', { name: 'Trashed projects' }).getByRole('button', { name: 'Delete forever' }).click()
  await expect(page.getByRole('list', { name: 'Trashed projects' })).toHaveCount(0)
  await expect(page.locator('.navigator')).toContainText('Site walk')
  await page.getByTestId('rail-notebooks').click()
  await page.locator('.navigator').getByRole('button', { name: /Panel wiring standard/ }).click()
  await expect(page.locator('.obj-text')).toHaveText('Use ferrules on every conductor')
})

test('a frozen window’s held project edits are merged safely when it takes editing back', async ({ context }) => {
  const a = await context.newPage()
  await a.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { value: undefined }))
  await a.goto('/')
  await newProject(a, 'Plant')
  await a.getByLabel('Customer').fill('Original customer')
  await waitSaved(a)
  // A's storage writes fail, then it edits the project details.
  await a.evaluate(() => {
    const w = window as unknown as { __put: typeof IDBObjectStore.prototype.put }
    w.__put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('Simulated full disk', 'QuotaExceededError')
    }
  })
  await a.getByLabel('Job number').fill('J-HELD')
  await expect(a.getByTestId('save-status')).toHaveAttribute('data-status', 'error')

  // B takes over (A never answers) and renames the project.
  const b = await context.newPage()
  await b.goto('/')
  await b.getByRole('button', { name: 'Edit here instead' }).click()
  await expect(b.getByTestId('readonly-banner')).toBeHidden({ timeout: 15_000 })
  await expect(a.getByTestId('readonly-banner')).toHaveAttribute('data-held', /^[1-9]/)
  await expect(a.getByLabel('Job number')).toHaveJSProperty('readOnly', true)
  await a.evaluate(() => {
    IDBObjectStore.prototype.put = (window as unknown as { __put: typeof IDBObjectStore.prototype.put }).__put
  })
  await openProject(b, 'Plant')
  await expect(b.getByLabel('Job number')).toHaveValue('') // A's edit was never written
  await b.getByLabel('Project name').fill('Plant (renamed in B)')
  await waitSaved(b)

  // A takes editing back: its job number is merged; B's newer name is kept.
  await a.getByRole('button', { name: 'Edit here and save them' }).click()
  await expect(a.getByTestId('readonly-banner')).toBeHidden({ timeout: 15_000 })
  await waitSaved(a)
  await expect(a.getByLabel('Project name')).toHaveValue('Plant (renamed in B)')
  await expect(a.getByLabel('Job number')).toHaveValue('J-HELD')
  await expect(a.getByLabel('Customer')).toHaveValue('Original customer')
  await b.reload()
  await openProject(b, 'Plant (renamed in B)')
  await expect(b.getByLabel('Job number')).toHaveValue('J-HELD')
})
