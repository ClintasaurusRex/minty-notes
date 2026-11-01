import { expect, test } from '@playwright/test'
import { addTextBox, dragBy, geometry, imageHash, newQuickNote, pageScale, pasteScreenshot, waitSaved } from './helpers'

/**
 * The milestone demonstration, end to end in real Chromium:
 * Inbox note → text → pasted screenshot → arrange → reload → backup →
 * restore into a clean workspace → same note, image bytes, layout, and links.
 */
test('capture, arrange, reload, back up, and restore into a clean workspace', async ({ page, browser }, testInfo) => {
  await page.goto('/')

  // 1. Unassigned note in the Inbox, with text.
  await newQuickNote(page)
  await expect(page.locator('.crumbs')).toContainText('Inbox')
  const text = await addTextBox(page, 'Pump 3 alarm wiring')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Check terminal X2:14 before energizing.')
  await page.keyboard.press('ControlOrMeta+A')
  await page.getByRole('button', { name: 'Bold (Ctrl+B)' }).click()
  await expect(text.locator('strong').first()).toBeVisible()

  // 2. Paste a screenshot from the clipboard.
  await pasteScreenshot(page)
  const image = page.locator('.obj-image')
  await expect(image).toHaveCount(1)
  const img = image.locator('img')
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

  // 3. Arrange it: move, then resize from a corner (aspect ratio kept).
  const scale = await pageScale(page)
  const start = await geometry(image)
  await dragBy(page, image, 300, 160)
  const moved = await geometry(image)
  expect(moved.x).toBeCloseTo(start.x + 300 / scale, -1)
  expect(moved.y).toBeCloseTo(start.y + 160 / scale, -1)
  const handle = image.locator('[data-handle="se"]')
  await dragBy(page, handle, 120, 0)
  const resized = await geometry(image)
  expect(resized.w).toBeGreaterThan(moved.w + 60)
  expect(resized.w / resized.h).toBeCloseTo(moved.w / moved.h, 1)

  // A second page filed in a notebook section, to verify links survive.
  await page.getByRole('button', { name: 'Notebooks' }).click()
  await page.getByRole('button', { name: 'New notebook' }).click()
  await page.getByLabel('Notebook name').fill('VTScada')
  await page.getByLabel('Notebook name').press('Enter')
  await page.getByRole('button', { name: 'Add page to General' }).click()
  await page.getByLabel('Page title').fill('Tag naming conventions')
  await addTextBox(page, 'Use AREA_EQUIP_SIGNAL')
  await expect(page.locator('.crumbs')).toContainText('VTScada › General')
  await page.getByRole('button', { name: 'Inbox' }).click()
  await page.locator('.nav-page').first().click()

  await waitSaved(page)
  const savedText = await text.innerText()
  const savedImage = await geometry(image)
  const savedHash = await imageHash(img)

  // 4. Reload and reopen: content and layout are unchanged.
  await page.reload()
  await expect(page.locator('.obj-image img')).toBeVisible()
  expect(await page.locator('.obj-text').first().innerText()).toBe(savedText)
  expect(await geometry(page.locator('.obj-image'))).toEqual(savedImage)
  expect(await imageHash(page.locator('.obj-image img'))).toBe(savedHash)

  // 5. Complete backup (downloadable fallback).
  await page.getByRole('button', { name: 'Settings' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^minty-notes-backup-\d{8}-\d{6}Z\.zip$/)
  const backupPath = testInfo.outputPath('backup.zip')
  await download.saveAs(backupPath)

  // 6. Restore into a clean workspace (a separate browser profile context).
  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fresh = await clean.newPage()
  await fresh.goto('/')
  await expect(fresh.getByTestId('home')).toBeVisible()
  await fresh.getByRole('button', { name: 'Settings' }).click()
  await fresh.getByTestId('restore-file').setInputFiles(backupPath)
  const review = fresh.getByTestId('restore-review')
  await expect(review).toContainText('passed every check')
  await expect(review.locator('dd').nth(3)).toHaveText('1') // notebooks
  await expect(review.locator('dd').nth(5)).toHaveText('2') // pages
  await fresh.getByRole('button', { name: 'Replace workspace' }).click()
  await expect(fresh.getByText(/Restored 0 projects, 2 pages, and 1 images/)).toBeVisible()
  await fresh.getByRole('button', { name: 'Done' }).click()

  // 7. Verify note, image bytes, layout, and notebook/page links.
  await fresh.getByRole('button', { name: 'Inbox' }).click()
  await fresh.locator('.nav-page').first().click()
  await expect(fresh.locator('.obj-image img')).toBeVisible()
  expect(await fresh.locator('.obj-text').first().innerText()).toBe(savedText)
  await expect(fresh.locator('.obj-text strong').first()).toBeVisible()
  expect(await geometry(fresh.locator('.obj-image'))).toEqual(savedImage)
  expect(await imageHash(fresh.locator('.obj-image img'))).toBe(savedHash)

  await fresh.getByRole('button', { name: 'Notebooks' }).click()
  await fresh.getByRole('button', { name: /Tag naming conventions/ }).click()
  await expect(fresh.locator('.crumbs')).toContainText('VTScada › General')
  await expect(fresh.locator('.obj-text')).toContainText('Use AREA_EQUIP_SIGNAL')
  await clean.close()
})
