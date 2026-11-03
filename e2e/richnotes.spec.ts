import { expect, test, type Page } from '@playwright/test'
import { addTextBox, newQuickNote, waitSaved } from './helpers'

async function makeLibraryPage(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'Notebooks' }).click()
  await page.getByRole('button', { name: 'New notebook' }).click()
  await page.getByLabel('Notebook name').fill('VTScada reference')
  await page.getByLabel('Notebook name').press('Enter')
  await page.getByRole('button', { name: 'Add page to General' }).click()
  await page.getByLabel('Page title').fill(title)
  await addTextBox(page, body)
}

const table = (page: Page) => page.locator('.obj-text table')

/**
 * Slice 1 in real Chromium: tables (keyboard + row/column controls), code
 * blocks and inline code, internal page links ([[ and Ctrl+Shift+K), link
 * navigation and Back, Trash/restore/delete-forever link states, undo,
 * reload, and a full backup → restore into a clean browser context.
 */
test('tables, code, and page links: editing, navigation, Trash and delete, reload, backup and clean restore', async ({ page, browser }, testInfo) => {
  await page.goto('/')
  await makeLibraryPage(page, 'Commissioning steps', 'Step 1: verify I/O')

  await newQuickNote(page)
  await page.getByLabel('Page title').fill('Pump station I/O')
  const box = await addTextBox(page, 'Pump I/O list')

  // Table from the toolbar, filled with the keyboard (Tab moves cell to cell, adding a row at the end).
  await page.getByRole('button', { name: /Insert table/ }).click()
  await expect(table(page)).toHaveCount(1)
  await expect(table(page).locator('tr')).toHaveCount(3)
  for (const cell of ['Tag', 'Address', 'Notes', 'P101_RUN', 'Local:1:I.Data.0', 'Run feedback', 'P101_FLT', 'Local:1:I.Data.1', 'Fault']) {
    await page.keyboard.type(cell)
    await page.keyboard.press('Tab')
  }
  await expect(table(page).locator('tr')).toHaveCount(4) // Tab in the last cell added a row
  await page.keyboard.type('P101_SPD')
  await expect(table(page).locator('th')).toHaveText(['Tag', 'Address', 'Notes'])

  // Row and column controls (shown only while the cursor is in a table).
  const tools = page.getByRole('group', { name: 'Table rows and columns' })
  await expect(tools).toBeVisible()
  await tools.getByRole('button', { name: 'Add column to the right' }).click()
  await expect(table(page).locator('tr').first().locator('th, td')).toHaveCount(4)
  await page.keyboard.press('Tab') // into the new, empty column
  await tools.getByRole('button', { name: 'Delete column' }).click()
  await expect(table(page).locator('tr').first().locator('th, td')).toHaveCount(3)
  await tools.getByRole('button', { name: 'Add row above' }).click()
  await expect(table(page).locator('tr')).toHaveCount(5)
  await page.keyboard.press('ArrowUp') // into the new, empty row
  await tools.getByRole('button', { name: 'Delete row' }).click()
  await expect(table(page).locator('tr')).toHaveCount(4)
  await expect(table(page)).toContainText('P101_SPD')

  // Undo inside the text box is the editor's own undo; redo brings it back.
  await page.keyboard.press('ControlOrMeta+Z')
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(table(page).locator('tr')).toHaveCount(4)

  // Leave the table (arrow past the last cell) and add a code block and inline code.
  await table(page).locator('td').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('Logic:')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Code block (Ctrl+Alt+C)' }).click()
  await page.keyboard.type('IF P101_RUN THEN')
  await page.keyboard.press('Enter')
  await page.keyboard.type('  Pump_OK := 1;')
  await expect(box.locator('pre')).toContainText('Pump_OK := 1;')
  // Three Enters leave the code block.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Scaled with `SCP` ')
  await expect(box.locator('p code')).toHaveText('SCP')

  // Page link by typing [[ — the picker filters as you type; Enter links.
  await page.keyboard.type('see [[')
  const picker = page.getByTestId('page-link-picker')
  await expect(picker).toBeVisible()
  await page.keyboard.type('commis')
  await expect(picker.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  const link = box.locator('a.page-link').first()
  await expect(link).toHaveText('Commissioning steps')
  await page.keyboard.type(' for details.')
  await expect(box).toContainText('Commissioning steps for details.')
  await expect(link).toHaveText('Commissioning steps') // typing after a link does not extend it

  // Page link on selected words with Ctrl+Shift+K.
  await page.keyboard.press('Enter')
  await page.keyboard.type('Checklist page')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('ControlOrMeta+Shift+K')
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape') // cancel keeps the text as it was
  await expect(picker).toBeHidden()
  await expect(box.locator('a.page-link')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+K')
  await picker.getByRole('combobox').fill('Commissioning')
  await picker.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(box.locator('a.page-link')).toHaveCount(2)
  await expect(box.locator('a.page-link').nth(1)).toHaveText('Checklist page')

  // Alt+F10 reaches the toolbar from the text; Esc returns to the text.
  await page.keyboard.press('Alt+F10')
  await expect(page.locator('.toolbar button:focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(box.locator('.ProseMirror')).toBeFocused()

  // Follow: Ctrl+click opens the page; Back returns.
  await link.click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByLabel('Page title')).toHaveValue('Commissioning steps')
  await expect(page.getByTestId('page-backlinks')).toContainText('Pump station I/O')
  await page.getByTestId('link-back').click()
  await expect(page.getByLabel('Page title')).toHaveValue('Pump station I/O')
  // Alt+Enter on a link (keyboard) also opens it.
  await box.locator('a.page-link').first().click()
  await page.keyboard.press('Alt+Enter')
  await expect(page.getByLabel('Page title')).toHaveValue('Commissioning steps')

  // The target moves to another place: the link still works (it is by ID).
  await page.getByRole('combobox', { name: 'Move page to' }).selectOption({ label: 'Standalone notes' })
  await page.getByTestId('link-back').click()
  await expect(link).toHaveAttribute('data-page-id', /.+/)
  await expect(link.locator('.page-link-ok')).toHaveAttribute('title', /Commissioning steps/)

  // Trash the target: the link shows it, and following offers to restore.
  await link.click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'Trash', exact: true }).last().click()
  await expect(page.locator('.notice').last()).toContainText('1 note links to it')
  await page.getByRole('button', { name: 'Inbox' }).click()
  await page.locator('.nav-page', { hasText: 'Pump station I/O' }).click()
  await expect(link.locator('.page-link-trashed')).toHaveAttribute('title', /in the Trash/)
  page.once('dialog', (d) => {
    expect(d.message()).toContain('is in the Trash. Restore it and open it?')
    void d.accept()
  })
  await link.click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByLabel('Page title')).toHaveValue('Commissioning steps')
  await page.getByTestId('link-back').click()
  await expect(link.locator('.page-link-ok')).toHaveCount(1)

  // Delete it forever: the confirmation counts the linking note; the link text stays, marked deleted.
  await link.click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'Trash', exact: true }).last().click()
  await page.getByRole('button', { name: 'Trash', exact: true }).first().click()
  page.once('dialog', (d) => {
    expect(d.message()).toContain('1 note links to it')
    void d.accept()
  })
  await page.locator('.trash-item', { hasText: 'Commissioning steps' }).getByRole('button', { name: 'Delete forever' }).click()
  await expect(page.locator('.trash-item', { hasText: 'Commissioning steps' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Inbox' }).click()
  await page.locator('.nav-page', { hasText: 'Pump station I/O' }).click()
  await expect(box.locator('.page-link-missing')).toHaveCount(2)
  await link.click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.notice').last()).toContainText('deleted forever')
  await expect(page.getByLabel('Page title')).toHaveValue('Pump station I/O')

  // Reload: the table, code, and links are unchanged.
  await waitSaved(page)
  const before = await box.locator('.ProseMirror').innerHTML()
  await page.reload()
  await expect(table(page).locator('tr')).toHaveCount(4)
  expect(await page.locator('.obj-text .ProseMirror').first().innerHTML()).toBe(before)

  // Full backup → restore in a separate, clean browser context.
  await page.getByRole('button', { name: 'Settings' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('rich-backup.zip')
  await (await downloadPromise).saveAs(backupPath)
  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fresh = await clean.newPage()
  await fresh.goto('/')
  await fresh.getByRole('button', { name: 'Settings' }).click()
  await fresh.getByTestId('restore-file').setInputFiles(backupPath)
  const review = fresh.getByTestId('restore-review')
  await expect(review).toContainText('passed every check')
  await expect(review).toContainText('1 note links to a page that was deleted forever')
  await fresh.getByRole('button', { name: 'Replace workspace' }).click()
  await fresh.getByRole('button', { name: 'Done' }).click()
  await fresh.getByRole('button', { name: 'Inbox' }).click()
  await fresh.locator('.nav-page', { hasText: 'Pump station I/O' }).click()
  await expect(fresh.locator('.obj-text table tr')).toHaveCount(4)
  await expect(fresh.locator('.obj-text pre')).toContainText('Pump_OK := 1;')
  await expect(fresh.locator('.obj-text .page-link-missing')).toHaveCount(2)
  expect(await fresh.locator('.obj-text .ProseMirror').first().innerHTML()).toBe(before)
  await clean.close()
})

/**
 * Pasted HTML (e.g. from a web page or a spreadsheet) keeps its table but never
 * stores unsafe content: spans are bounded, script/javascript links/images are
 * dropped, and the result still passes backup validation. A read-only window
 * follows page links with a plain click.
 */
test('pasted tables are sanitized and still back up; a read-only window follows page links', async ({ page, context }) => {
  await page.goto('/')
  await makeLibraryPage(page, 'Panel drawing notes', 'Terminal strip X2')
  await newQuickNote(page)
  await page.getByLabel('Page title').fill('Pasted from the web')
  const html =
    '<p>Before <a href="javascript:alert(1)">bad link</a> <a href="https://example.com/doc">good link</a></p>' +
    '<script>window.__pwned = true</script><img src="x" onerror="window.__pwned = true">' +
    '<table><tr><th colspan="99999">Wide header</th></tr><tr><td rowspan="abc">A</td><td colwidth="NaN,5">B</td></tr></table>'
  await page.evaluate(async (h) => {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([h], { type: 'text/html' }), 'text/plain': new Blob(['Before bad link good link'], { type: 'text/plain' }) })])
  }, html)
  await page.getByTestId('page-surface').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('ControlOrMeta+V')
  const box = page.locator('.obj-text').filter({ hasText: 'Wide header' })
  await expect(box).toHaveCount(1)
  await expect(box.locator('th')).toHaveAttribute('colspan', '50')
  await expect(box.locator('a[href^="javascript"]')).toHaveCount(0)
  await expect(box.locator('a[href="https://example.com/doc"]')).toHaveCount(1)
  await expect(box.locator('img, script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined()

  // Add a page link, then check everything passes backup validation.
  await box.locator('td').last().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' [[Panel')
  await page.keyboard.press('Enter')
  await expect(box.locator('a.page-link')).toHaveText('Panel drawing notes')
  await waitSaved(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  await (await downloadPromise).saveAs(test.info().outputPath('pasted.zip'))
  await page.getByTestId('restore-file').setInputFiles(test.info().outputPath('pasted.zip'))
  await expect(page.getByTestId('restore-review')).toContainText('passed every check')
  await page.getByRole('button', { name: 'Cancel' }).click()

  // A second window is read-only; a plain click on a page link opens the page there.
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByTestId('readonly-banner')).toBeVisible()
  await second.getByRole('button', { name: 'Inbox' }).click()
  await second.locator('.nav-page', { hasText: 'Pasted from the web' }).click()
  await second.locator('.obj-text a.page-link').click()
  await expect(second.getByLabel('Page title')).toHaveValue('Panel drawing notes')
  await second.getByTestId('link-back').click()
  await expect(second.getByLabel('Page title')).toHaveValue('Pasted from the web')
  await second.close()
})
