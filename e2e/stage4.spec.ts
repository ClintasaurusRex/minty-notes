import { expect, test, type Page } from '@playwright/test'
import { makeTechnicalPdf } from '../src/test/docFixtures'
import { addTextBox, pasteScreenshot, waitSaved } from './helpers'

/** Annotation count of the first marked-up image (or sketch) on the page. */
const svgItems = (page: Page, sel: string) => page.locator(`${sel} .markup-view`).first().evaluate((svg) => svg.querySelectorAll('g.mk-item, rect.mk-item').length)

/**
 * The Stage 4 milestone in one real-Chromium workflow: a project with an
 * imported control narrative (PDF) and a technical note that has a table,
 * code, a link to the imported page, a marked-up screenshot (with redaction),
 * and a sketch → reload → full backup → restore into a clean browser context
 * → everything matches.
 */
test('representative technical project: imported narrative, table, code, page link, marked-up screenshot, sketch, backup and clean restore', async ({ page, browser }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill('Lift Station 7 upgrade')
  await page.getByLabel('Project name').press('Tab')

  // Import the control narrative into the project.
  await page.locator('.navigator [data-testid=import-file]').first().setInputFiles({ name: 'LS7 control narrative.pdf', mimeType: 'application/pdf', buffer: Buffer.from(makeTechnicalPdf()) })
  await expect(page.getByLabel('Page title')).toHaveValue('LS7 control narrative')
  await expect(page.locator('.crumbs')).toContainText('Lift Station 7 upgrade')
  await expect(page.getByTestId('import-banner')).toBeVisible()

  // A project note: table, code, page link to the imported narrative.
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
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Code block (Ctrl+Alt+C)' }).click()
  await page.keyboard.type('IF LSH_101 THEN Start_Lag := 1; END_IF;')
  await page.keyboard.press('Escape')

  // A marked-up screenshot with a redaction box and an arrow.
  await pasteScreenshot(page, 'HMI LS7', { w: 600, h: 320 })
  const image = page.locator('.obj-image')
  await expect(image.locator('img')).toHaveCount(1)
  await image.click()
  await page.getByRole('button', { name: /^Mark up:/ }).click()
  const svg = page.locator('.markup-svg')
  const r = (await svg.boundingBox())!
  const at = (x: number, y: number) => page.mouse.move(r.x + r.width * x, r.y + r.height * y, { steps: 4 })
  await at(0.2, 0.7)
  await page.mouse.down()
  await at(0.5, 0.4)
  await page.mouse.up()
  await page.keyboard.press('x')
  await at(0.6, 0.1)
  await page.mouse.down()
  await at(0.9, 0.3)
  await page.mouse.up()
  await page.getByTestId('markup-done').click()
  await expect(image.locator('.markup-view')).toBeVisible()
  const markedItems = await svgItems(page, '.obj-image')
  expect(markedItems).toBe(2)

  // A small wiring sketch.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Add a sketch/ }).click()
  await page.keyboard.press('l')
  await page.keyboard.press('Enter')
  await page.keyboard.press('t')
  await page.keyboard.press('Enter')
  await page.getByLabel('Label text').fill('LSH-101 → PLC DI 4')
  await page.getByLabel('Label text').press('Enter')
  await page.getByTestId('markup-done').click()
  await expect(page.locator('.obj-sketch')).toHaveCount(1)

  // Follow the link to the imported page and come back.
  await box.locator('a.page-link').click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByLabel('Page title')).toHaveValue('LS7 control narrative')
  await expect(page.getByTestId('page-backlinks')).toContainText('Commissioning notes')
  await page.getByTestId('link-back').click()
  await expect(page.getByLabel('Page title')).toHaveValue('Commissioning notes')

  await waitSaved(page)
  await page.reload()
  await expect(page.locator('.obj-text table tr')).toHaveCount(2)
  const noteHtml = await page.locator('.obj-text .ProseMirror').first().innerHTML()

  // Full backup → restore in a clean browser context.
  await page.getByRole('button', { name: 'Settings' }).click()
  const dl = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('stage4-backup.zip')
  await (await dl).saveAs(backupPath)
  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fresh = await clean.newPage()
  await fresh.goto('/')
  await fresh.getByRole('button', { name: 'Settings' }).click()
  await fresh.getByTestId('restore-file').setInputFiles(backupPath)
  const review = fresh.getByTestId('restore-review')
  await expect(review).toContainText('passed every check')
  await expect(review).toContainText('format 4')
  await fresh.getByRole('button', { name: 'Replace workspace' }).click()
  await fresh.getByRole('button', { name: 'Done' }).click()

  await fresh.getByRole('button', { name: 'Projects' }).click()
  await fresh.getByRole('button', { name: /Lift Station 7 upgrade/ }).click()
  await fresh.locator('.navigator .nav-page', { hasText: 'Commissioning notes' }).click()
  await expect(fresh.locator('.obj-text table tr')).toHaveCount(2)
  expect(await fresh.locator('.obj-text .ProseMirror').first().innerHTML()).toBe(noteHtml)
  await expect(fresh.locator('.obj-text pre')).toContainText('Start_Lag := 1;')
  await expect(fresh.locator('.obj-image .markup-view')).toBeVisible()
  expect(await svgItems(fresh, '.obj-image')).toBe(markedItems)
  await expect(fresh.locator('.obj-sketch .markup-view text')).toContainText('LSH-101 → PLC DI 4')
  await fresh.locator('.obj-text a.page-link').click({ modifiers: ['ControlOrMeta'] })
  await expect(fresh.getByLabel('Page title')).toHaveValue('LS7 control narrative')
  await expect(fresh.getByTestId('import-banner')).toContainText('LS7 control narrative.pdf')
  await fresh.getByTestId('import-banner').getByRole('button', { name: 'Preview original' }).click()
  await expect(fresh.getByTestId('preview-page')).toHaveText('Page 1 of 3')
  await clean.close()
})
