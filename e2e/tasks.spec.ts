import { expect, test, type Page } from '@playwright/test'
import { addTextBox, imageHash, pasteScreenshot, waitSaved } from './helpers'

/**
 * Stage 3 in real Chromium (production build): a synthetic VTScada job from
 * project creation through references, files, tasks, note links, templates,
 * archive, and backup → clean restore.
 */

async function newProject(page: Page, name: string) {
  await page.getByTestId('rail-projects').click()
  const back = page.getByRole('button', { name: /All projects/ })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(name)
}

async function openProject(page: Page, name: string, tab: 'overview' | 'tasks' | 'files' = 'overview') {
  await page.getByTestId('rail-projects').click()
  const back = page.getByRole('button', { name: /All projects/ })
  if (await back.isVisible()) await back.click()
  await page.locator('.navigator').getByRole('button', { name: new RegExp(name.replace(/[()]/g, '\\$&')) }).click()
  await expect(page.getByLabel('Project name')).toHaveValue(name)
  await page.getByTestId(`tab-${tab}`).click()
}

const column = (page: Page, status: 'todo' | 'doing' | 'done') => page.getByTestId(`column-${status}`)
const card = (page: Page, title: string) => page.getByTestId('task-card').filter({ hasText: title })

async function addTask(page: Page, title: string) {
  await page.getByLabel('New task title').fill(title)
  await page.getByLabel('New task title').press('Enter')
  await expect(card(page, title)).toBeVisible()
}

/** Local date `days` from today as YYYY-MM-DD (what a date field holds). */
async function localDate(page: Page, days: number): Promise<string> {
  return page.evaluate((d) => {
    const t = new Date()
    t.setDate(t.getDate() + d)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
  }, days)
}

test('VTScada job: references, files, tasks, note links, templates, archive, backup and clean restore', async ({ page, browser }, testInfo) => {
  page.on('dialog', (d) => void (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()))
  await page.goto('/')

  // Library reference in the VTScada starter notebook (category VTScada).
  await page.getByTestId('rail-notebooks').click()
  await page.getByRole('button', { name: 'Add starter notebooks' }).click()
  await page.getByRole('button', { name: 'Add page to General' }).first().click()
  await page.getByLabel('Page title').fill('Alarm priority standard')
  await addTextBox(page, 'Priority 1 = critical, page on-call')
  await waitSaved(page)

  // Project with categories; the reference is suggested, then pinned (shared, not copied).
  await newProject(page, 'Riverside WTP SCADA upgrade')
  await page.getByLabel('Customer').fill('Riverside Water (synthetic)')
  await page.getByLabel('Job number').fill('J-4410')
  await page.getByLabel('Add system category to project').fill('VTScada')
  await page.getByLabel('Add system category to project').press('Enter')
  await page.getByLabel('Add system category to project').fill('Panel building')
  await page.getByLabel('Add system category to project').press('Enter')
  await expect(page.getByTestId('ref-suggested')).toContainText('Alarm priority standard')
  await page.getByTestId('ref-suggested').getByRole('button', { name: 'Pin Alarm priority standard' }).click()
  await expect(page.getByTestId('ref-pinned')).toContainText('Alarm priority standard')

  // A project note with text and a pasted screenshot.
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('Page title').fill('Commissioning notes')
  await addTextBox(page, 'PLC-2 I/O checkout: 48 of 52 points verified')
  await page.getByTestId('page-surface').click({ position: { x: 900, y: 900 } })
  await pasteScreenshot(page, 'TAG BROWSER')
  await expect(page.locator('.obj-image img')).toBeVisible()
  await waitSaved(page)
  const hash = await imageHash(page.locator('.obj-image img'))

  // Files tab: a local path (copy only) and a Dropbox web link (opens in a new tab).
  await openProject(page, 'Riverside WTP SCADA upgrade', 'files')
  await page.getByRole('button', { name: 'Add local path' }).click()
  await page.getByLabel('Name of location 1').fill('Job folder')
  await page.getByLabel('Path of location 1').fill('D:\\Dropbox\\Jobs\\J-4410')
  await page.getByLabel('Description of location 1').fill('PLC backups and panel drawings')
  await page.getByRole('button', { name: 'Add web link' }).click()
  await page.getByLabel('Name of location 2').fill('Dropbox share')
  await page.getByLabel('Link of location 2').fill('https://www.dropbox.com/scl/fo/synthetic/J-4410')
  const files = page.getByTestId('file-item')
  await expect(files.nth(0).getByRole('link')).toHaveCount(0) // a local path never pretends to open
  await expect(files.nth(1).getByRole('link', { name: 'Open Dropbox share in a new tab' })).toHaveAttribute('href', 'https://www.dropbox.com/scl/fo/synthetic/J-4410')
  await expect(files.nth(1).getByRole('link')).toHaveAttribute('target', '_blank')
  await files.nth(0).getByRole('button', { name: 'Copy Job folder' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('D:\\Dropbox\\Jobs\\J-4410')
  // An unsafe scheme is kept for copying but never becomes a link.
  await page.getByRole('button', { name: 'Add web link' }).click()
  await page.getByLabel('Link of location 3').fill('javascript:alert(1)')
  await expect(files.nth(2)).toContainText('Only http and https links can be opened')
  await expect(files.nth(2).getByRole('link')).toHaveCount(0)
  await files.nth(2).getByRole('button', { name: 'Remove location 3' }).click()
  await waitSaved(page)

  // Tasks: add, edit (priority, due date, details), and link notes.
  await page.getByTestId('tab-tasks').click()
  await addTask(page, 'Configure alarm list')
  await addTask(page, 'Historian tag check')
  await addTask(page, 'Factory acceptance test')
  const overdueDate = await localDate(page, -2)
  const soonDate = await localDate(page, 3)
  await card(page, 'Configure alarm list').locator('.task-title-btn').click()
  const editor = page.getByTestId('task-editor')
  await expect(editor).toBeVisible()
  await editor.getByLabel('Task priority').selectOption('urgent')
  await editor.getByLabel('Task due date').fill(overdueDate)
  await editor.getByLabel('Task details').fill('Map priorities per the standard')
  await editor.getByLabel('Find a note to link').fill('commissioning')
  await editor.locator('.pin-results').getByRole('button', { name: 'Link' }).click()
  await editor.getByLabel('Find a note to link').fill('alarm priority')
  await editor.locator('.pin-results').getByRole('button', { name: 'Link' }).click()
  await expect(editor.getByTestId('task-links')).toContainText('Commissioning notes')
  await expect(editor.getByTestId('task-links')).toContainText('Alarm priority standard')
  await editor.getByRole('button', { name: 'Close' }).click()
  await expect(editor).toBeHidden()
  const urgent = card(page, 'Configure alarm list')
  await expect(urgent.locator('.prio-urgent')).toHaveText(/Urgent/)
  await expect(urgent.getByTestId('task-due')).toHaveAttribute('data-tone', 'overdue')
  await expect(urgent).toContainText('2 notes')
  await card(page, 'Historian tag check').locator('.task-title-btn').click()
  await editor.getByLabel('Task due date').fill(soonDate)
  await editor.getByLabel('Task priority').selectOption('high')
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
  await expect(card(page, 'Historian tag check').getByTestId('task-due')).toHaveAttribute('data-tone', 'soon')

  // Keyboard moves without dragging: Alt+→ to Doing, Alt+↓ / Alt+↑ within To do, then the move buttons.
  await card(page, 'Configure alarm list').locator('.task-title-btn').focus()
  await page.keyboard.press('Alt+ArrowRight')
  await expect(column(page, 'doing')).toContainText('Configure alarm list')
  await expect(page.getByTestId('board-announce')).toHaveText('Moved “Configure alarm list” to Doing, position 1 of 1.')
  await expect(card(page, 'Configure alarm list').locator('.task-title-btn')).toBeFocused() // focus follows the card
  await card(page, 'Historian tag check').locator('.task-title-btn').focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(column(page, 'todo').getByTestId('task-card').first()).toContainText('Factory acceptance test')
  await page.keyboard.press('Alt+ArrowUp')
  await expect(column(page, 'todo').getByTestId('task-card').first()).toContainText('Historian tag check')
  await card(page, 'Historian tag check').getByRole('button', { name: 'Move to Doing' }).click()
  await expect(column(page, 'doing').getByTestId('task-card')).toHaveCount(2)
  // Complete one with its check box.
  await card(page, 'Historian tag check').getByRole('button', { name: 'Complete “Historian tag check”' }).click()
  await expect(column(page, 'done')).toContainText('Historian tag check')
  await waitSaved(page)

  // A linked note opens from the task, and the note links back to its tasks.
  await card(page, 'Configure alarm list').locator('.task-title-btn').click()
  await editor.getByTestId('task-links').getByRole('button', { name: /^Commissioning notes/ }).click()
  await expect(page.getByLabel('Page title')).toHaveValue('Commissioning notes')
  await expect(page.getByTestId('task-backlinks')).toContainText('Configure alarm list')
  await page.getByTestId('task-backlinks').getByRole('button', { name: /Configure alarm list/ }).click()
  await expect(page.getByTestId('task-editor')).toBeVisible()
  await expect(page.getByTestId('task-editor').getByLabel('Task title')).toHaveValue('Configure alarm list')
  await page.keyboard.press('Escape')

  // Combined task view: overdue filter, project identity, and navigation to the board.
  await page.getByTestId('rail-tasks').click()
  await expect(page.getByTestId('task-row')).toHaveCount(2) // open tasks only
  await page.getByTestId('overdue-count').click()
  await expect(page.getByTestId('task-row')).toHaveCount(1)
  await expect(page.getByTestId('task-row')).toContainText('Configure alarm list')
  await expect(page.getByTestId('task-row')).toContainText('Riverside WTP SCADA upgrade')
  await expect(page.getByTestId('task-row')).toContainText('Doing')
  await page.getByLabel('Due date filter').selectOption('any')
  await page.getByLabel('Status filter').selectOption('all')
  await page.getByLabel('Sort tasks').selectOption('priority')
  await expect(page.getByTestId('task-row').first()).toContainText('Configure alarm list')
  await page.getByTestId('task-row').filter({ hasText: 'Factory acceptance test' }).locator('.ref-open').click()
  await expect(page.getByTestId('task-editor').getByLabel('Task title')).toHaveValue('Factory acceptance test')
  await page.keyboard.press('Escape')

  // Home lists overdue and upcoming tasks and the project's next task.
  await page.getByTestId('rail-home').click()
  await expect(page.getByTestId('home-due-tasks')).toContainText('Configure alarm list')
  await expect(page.getByTestId('tile-next-task')).toContainText('Next: Configure alarm list')

  // Templates: save the project as a template, then start a new job from it.
  await openProject(page, 'Riverside WTP SCADA upgrade')
  await page.getByRole('button', { name: 'Save as template' }).click()
  await expect(page.getByText(/Saved the template “Riverside WTP SCADA upgrade template”/)).toBeVisible()
  await page.getByTestId('rail-home').click()
  await page.getByTestId('template-picker').selectOption({ label: 'Riverside WTP SCADA upgrade template' })
  await expect(page.getByLabel('Project name')).toHaveValue('Riverside WTP SCADA upgrade template')
  await page.getByLabel('Project name').fill('Hillside reservoir SCADA')
  await expect(page.getByLabel('Customer')).toHaveValue('') // job details are not copied
  await expect(page.getByTestId('ref-pinned')).toContainText('Alarm priority standard') // still the shared original
  await page.getByTestId('tab-tasks').click()
  await expect(column(page, 'todo').getByTestId('task-card')).toHaveCount(3) // a fresh To do list
  await card(page, 'Configure alarm list').locator('.task-title-btn').click()
  await expect(page.getByTestId('task-links')).toContainText('Commissioning notes')
  await page.getByTestId('task-links').getByRole('button', { name: /^Commissioning notes/ }).click()
  await expect(page.locator('.crumbs')).toContainText('Hillside reservoir SCADA') // the new project's own note
  await expect(page.locator('.obj-text')).toHaveText('PLC-2 I/O checkout: 48 of 52 points verified')
  expect(await imageHash(page.locator('.obj-image img'))).toBe(hash)
  // Editing the generated note leaves the original job's note alone.
  await page.locator('.obj-text .ProseMirror').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Hillside checkout pending')
  await waitSaved(page)
  await openProject(page, 'Riverside WTP SCADA upgrade')
  await page.locator('.navigator').getByRole('button', { name: /Commissioning notes/ }).click()
  await expect(page.locator('.obj-text')).toHaveText('PLC-2 I/O checkout: 48 of 52 points verified')
  await page.getByTestId('rail-settings').click()
  await expect(page.getByTestId('template-row')).toContainText('Project template · 1 note · 3 tasks')

  // Reload: board order, status, and links persist.
  await page.reload()
  await openProject(page, 'Riverside WTP SCADA upgrade', 'tasks')
  await expect(column(page, 'doing').getByTestId('task-card')).toHaveText([/Configure alarm list/])
  await expect(column(page, 'done').getByTestId('task-card')).toHaveText([/Historian tag check/])

  // Archive: tasks leave the default task list, and come back with "Include archived".
  await page.getByTestId('tab-overview').click()
  await page.getByRole('button', { name: 'Archive' }).click()
  await page.getByTestId('rail-tasks').click()
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page.getByTestId('task-row')).toHaveCount(3) // only Hillside's
  await page.getByLabel('Include archived projects').check()
  await expect(page.getByTestId('task-row')).toHaveCount(5)
  await expect(page.getByTestId('task-row').filter({ hasText: 'Riverside WTP SCADA upgrade (archived)' })).toHaveCount(2)
  await waitSaved(page)

  // Full backup → restore into a separate clean browser context.
  await page.getByTestId('rail-settings').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('stage3-backup.zip')
  await (await downloadPromise).saveAs(backupPath)

  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const fresh = await clean.newPage()
  await fresh.goto('/')
  await fresh.getByTestId('rail-settings').click()
  await fresh.getByTestId('restore-file').setInputFiles(backupPath)
  await expect(fresh.getByTestId('restore-review')).toContainText('passed every check')
  await expect(fresh.getByTestId('restore-tasks')).toHaveText('6 (1 done)')
  await expect(fresh.getByTestId('restore-templates')).toHaveText('1')
  await fresh.getByRole('button', { name: 'Replace workspace' }).click()
  await expect(fresh.getByText(/Restored 2 projects, 3 pages, and 1 images\. Also 6 tasks and 1 templates\./)).toBeVisible()
  await fresh.getByRole('button', { name: 'Done' }).click()
  await fresh.getByTestId('rail-projects').click()
  await fresh.getByRole('button', { name: 'Archived', exact: true }).click()
  await fresh.locator('.navigator').getByRole('button', { name: /Riverside WTP SCADA upgrade/ }).click()
  await fresh.getByTestId('tab-tasks').click()
  await expect(column(fresh, 'doing').getByTestId('task-card')).toHaveText([/Configure alarm list/])
  await card(fresh, 'Configure alarm list').locator('.task-title-btn').click()
  const restoredEditor = fresh.getByTestId('task-editor')
  await expect(restoredEditor.getByLabel('Task due date')).toHaveValue(overdueDate) // the date did not move
  await expect(restoredEditor.getByLabel('Task priority')).toHaveValue('urgent')
  await expect(restoredEditor.getByTestId('task-links')).toContainText('Commissioning notes')
  await expect(restoredEditor.getByTestId('task-links')).toContainText('Alarm priority standard')
  await fresh.keyboard.press('Escape')
  await fresh.getByTestId('tab-files').click()
  await expect(fresh.getByLabel('Path of location 1')).toHaveValue('D:\\Dropbox\\Jobs\\J-4410')
  await expect(fresh.getByLabel('Description of location 1')).toHaveValue('PLC backups and panel drawings')
  await expect(fresh.getByTestId('file-item').nth(1).getByRole('link')).toHaveAttribute('href', 'https://www.dropbox.com/scl/fo/synthetic/J-4410')
  await fresh.getByTestId('rail-settings').click()
  await expect(fresh.getByTestId('template-row').getByRole('textbox').first()).toHaveValue('Riverside WTP SCADA upgrade template')
  await clean.close()
})

test('task due dates cannot be corrupted by a mistyped year; note templates; delete and Trash keep note links safe', async ({ page }) => {
  page.on('dialog', (d) => void (d.type() === 'prompt' ? d.accept('Wiring checklist') : d.accept()))
  await page.goto('/')
  await newProject(page, 'Typo job')
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('Page title').fill('Wiring notes')
  await addTextBox(page, 'Label both ends of every wire')
  await waitSaved(page)
  // Save the page as a note template and make an independent Inbox note from it.
  await page.locator('.page-header').getByRole('button', { name: 'Save as template' }).click()
  await expect(page.getByText(/Saved the template “Wiring checklist”/)).toBeVisible()
  await page.getByTestId('rail-home').click()
  await page.getByTestId('template-picker').selectOption({ label: 'Wiring checklist' })
  await expect(page.getByLabel('Page title')).toHaveValue('Wiring notes')
  await expect(page.locator('.crumbs')).toContainText('Inbox')
  await expect(page.locator('.obj-text')).toHaveText('Label both ends of every wire')
  await waitSaved(page)
  await openProject(page, 'Typo job', 'tasks')
  await addTask(page, 'Pull wire')
  await card(page, 'Pull wire').locator('.task-title-btn').click()
  const editor = page.getByTestId('task-editor')
  const due = editor.getByLabel('Task due date')
  // Typed digit by digit in Chrome's real date field: a five-digit year is capped at four digits.
  await due.click({ position: { x: 14, y: 12 } })
  for (const key of '121520261') await page.keyboard.press(key)
  await page.keyboard.press('Tab')
  await expect(due).toHaveValue(/^\d{4}-12-15$/)
  await editor.getByLabel('Find a note to link').fill('wiring')
  // Two pages are titled “Wiring notes” now (the project note and its template copy in the Inbox).
  await editor.locator('.pin-results li').filter({ hasText: 'Typo job' }).getByRole('button', { name: 'Link' }).click()
  await page.keyboard.press('Escape')
  await waitSaved(page)
  const stored = await page.evaluate(
    () =>
      new Promise<{ dueDate: string | null; links: number }>((resolve, reject) => {
        const req = indexedDB.open('minty-notes')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const get = req.result.transaction('tasks').objectStore('tasks').getAll()
          get.onsuccess = () => resolve({ dueDate: get.result[0].dueDate, links: get.result[0].linkedPageIds.length })
        }
      }),
  )
  expect(stored.dueDate).toMatch(/^\d{4}-12-15$/)
  expect(stored.links).toBe(1)

  // Trash the note: the task shows it as in the Trash; deleting it forever removes the link.
  await page.locator('.navigator').getByRole('button', { name: /Wiring notes/ }).click()
  await page.locator('.page-header').getByRole('button', { name: 'Trash', exact: true }).click()
  await openProject(page, 'Typo job', 'tasks')
  await card(page, 'Pull wire').locator('.task-title-btn').click()
  await expect(editor.getByTestId('task-links')).toContainText('In the Trash')
  await page.keyboard.press('Escape')
  await page.getByTestId('rail-trash').click()
  await page.locator('.trash-item').filter({ hasText: 'Wiring notes' }).getByRole('button', { name: /Delete forever/ }).click()
  await openProject(page, 'Typo job', 'tasks')
  await expect(card(page, 'Pull wire')).not.toContainText('note')
  // The template outlives the deleted page (and the Inbox copy is untouched).
  await page.getByTestId('rail-inbox').click()
  await page.locator('.navigator').getByRole('button', { name: /Wiring notes/ }).click()
  await expect(page.locator('.obj-text')).toHaveText('Label both ends of every wire')
  await openProject(page, 'Typo job', 'tasks')
  // Delete the task itself.
  await card(page, 'Pull wire').locator('.task-title-btn').click()
  await editor.getByRole('button', { name: 'Delete task' }).click()
  await expect(page.getByTestId('task-card')).toHaveCount(0)
  await waitSaved(page)
})

test('a frozen window’s held task edits are merged safely when it takes editing back', async ({ context }) => {
  const a = await context.newPage()
  await a.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { value: undefined }))
  await a.goto('/')
  await newProject(a, 'Plant')
  await a.getByTestId('tab-tasks').click()
  await addTask(a, 'Wire panel')
  await waitSaved(a)
  // A's storage writes fail, then it changes the task's priority and moves it.
  await a.evaluate(() => {
    const w = window as unknown as { __put: typeof IDBObjectStore.prototype.put }
    w.__put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('Simulated full disk', 'QuotaExceededError')
    }
  })
  await card(a, 'Wire panel').getByRole('button', { name: 'Move to Doing' }).click()
  await expect(a.getByTestId('save-status')).toHaveAttribute('data-status', 'error')

  // B takes over (A never answers) and renames the task.
  const b = await context.newPage()
  await b.goto('/')
  await b.getByRole('button', { name: 'Edit here instead' }).click()
  await expect(b.getByTestId('readonly-banner')).toBeHidden({ timeout: 15_000 })
  await expect(a.getByTestId('readonly-banner')).toHaveAttribute('data-held', /^[1-9]/)
  await expect(card(a, 'Wire panel').getByRole('button', { name: 'Move to Done' })).toHaveCount(0) // read-only: no move controls
  await a.evaluate(() => {
    IDBObjectStore.prototype.put = (window as unknown as { __put: typeof IDBObjectStore.prototype.put }).__put
  })
  await openProject(b, 'Plant', 'tasks')
  await expect(column(b, 'todo')).toContainText('Wire panel') // A's move was never written
  await card(b, 'Wire panel').locator('.task-title-btn').click()
  await b.getByTestId('task-editor').getByLabel('Task title').fill('Wire panel (renamed in B)')
  await b.keyboard.press('Escape')
  await waitSaved(b)

  // A takes editing back: its move is merged; B's newer title is kept.
  await a.getByRole('button', { name: 'Edit here and save them' }).click()
  await expect(a.getByTestId('readonly-banner')).toBeHidden({ timeout: 15_000 })
  await waitSaved(a)
  await expect(column(a, 'doing')).toContainText('Wire panel (renamed in B)')
  await b.reload()
  await openProject(b, 'Plant', 'tasks')
  await expect(column(b, 'doing')).toContainText('Wire panel (renamed in B)')
})
