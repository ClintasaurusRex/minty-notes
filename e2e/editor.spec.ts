import { expect, test } from '@playwright/test'
import { addTextBox, dragBy, geometry, newQuickNote, pasteScreenshot } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await newQuickNote(page)
})

test('selecting text never moves the box; the grip moves it without touching the text', async ({ page }) => {
  const box = await addTextBox(page, 'alpha beta gamma delta')
  const start = await geometry(box)
  const para = box.locator('.rt p').first()
  const r = (await para.boundingBox())!

  // Drag across the text: a text selection, not a move.
  await page.mouse.move(r.x + 2, r.y + r.height / 2)
  await page.mouse.down()
  await page.mouse.move(r.x + r.width - 4, r.y + r.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await geometry(box)).toEqual(start)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('beta gamma')

  // Drag the grip: a move, text unchanged.
  await dragBy(page, box.locator('.obj-grip'), 200, 120)
  const moved = await geometry(box)
  expect(moved.x).toBeGreaterThan(start.x + 150)
  expect(moved.y).toBeGreaterThan(start.y + 90)
  await expect(box).toHaveText('alpha beta gamma delta')

  // Resizing the width rewraps text and the height follows the content.
  await box.locator('.rt').click()
  const before = await geometry(box)
  await dragBy(page, box.locator('[data-handle="e"]'), -(before.w - 140), 0)
  const narrow = await geometry(box)
  expect(narrow.w).toBeLessThan(before.w)
  expect(narrow.h).toBeGreaterThan(before.h)
})

test('keyboard alternatives: move, resize, delete, and undo without a mouse drag', async ({ page }) => {
  const box = await addTextBox(page, 'Keyboard box')
  await page.keyboard.press('Escape')
  await expect(box).toBeFocused()
  const g0 = await geometry(box)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  expect(await geometry(box)).toMatchObject({ x: g0.x + 2, y: g0.y + 10 })
  await page.keyboard.press('Shift+Alt+ArrowRight')
  expect((await geometry(box)).w).toBe(g0.w + 10)

  // Numeric fields are another keyboard route.
  await page.getByLabel('X position or size in pixels').fill('300')
  await page.getByLabel('X position or size in pixels').press('Enter')
  expect((await geometry(box)).x).toBe(300)

  await box.focus()
  await page.keyboard.press('Delete')
  await expect(page.locator('.obj-text')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(page.locator('.obj-text')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Z') // the X field change
  expect((await geometry(page.locator('.obj-text'))).x).toBe(g0.x + 2)
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  expect((await geometry(page.locator('.obj-text'))).x).toBe(300)

  // Enter returns to editing the text.
  await page.locator('.obj-text').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.type(' more')
  await expect(page.locator('.obj-text')).toHaveText('Keyboard box more')
})

test('undo inside text undoes typing; undo on the page undoes layout', async ({ page }) => {
  const box = await addTextBox(page, 'one')
  await dragBy(page, box.locator('.obj-grip'), 160, 0)
  const moved = await geometry(box)
  // ProseMirror groups typing within 500 ms into one undo step; pause like a person would.
  await page.waitForTimeout(700)
  await box.locator('.rt').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' two')
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(box).toHaveText('one')
  expect(await geometry(box)).toEqual(moved)

  // Leave the text, then undo on the page: the move is undone, text stays.
  await page.getByTestId('page-surface').click({ position: { x: 900, y: 900 } })
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(box).toHaveText('one')
  expect((await geometry(box)).x).toBeLessThan(moved.x)
})

test('an empty new text box disappears when you click away', async ({ page }) => {
  await page.getByRole('button', { name: 'Add text box' }).click()
  await expect(page.locator('.obj-text')).toHaveCount(1)
  await page.getByTestId('page-surface').click({ position: { x: 900, y: 900 } })
  await expect(page.locator('.obj-text')).toHaveCount(0)
})

test('paste places images without covering content, and text paste makes a text box', async ({ page }) => {
  const box = await addTextBox(page, 'Above the screenshot')
  await page.getByTestId('page-surface').click({ position: { x: 900, y: 900 } })
  await pasteScreenshot(page, 'ONE')
  const image = page.locator('.obj-image')
  await expect(image).toHaveCount(1)
  const t = await geometry(box)
  const i = await geometry(image)
  expect(i.y).toBeGreaterThanOrEqual(t.y + t.h)

  // A second paste goes below the selected image.
  await pasteScreenshot(page, 'TWO')
  await expect(image).toHaveCount(2)
  const second = await geometry(image.nth(1))
  expect(second.y).toBeGreaterThanOrEqual(i.y + i.h)

  // Plain text pasted outside a text box becomes a new text box.
  await page.getByTestId('page-surface').click({ position: { x: 1000, y: 1200 } })
  await page.evaluate(() => navigator.clipboard.writeText('Pasted plain text'))
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.locator('.obj-text').filter({ hasText: 'Pasted plain text' })).toHaveCount(1)
})

test('the page grows downward as content moves lower', async ({ page }) => {
  const box = await addTextBox(page, 'Low note')
  await page.keyboard.press('Escape')
  const surface = page.getByTestId('page-surface')
  const h0 = await surface.evaluate((el) => (el as HTMLElement).offsetHeight)
  await page.getByLabel('Y position or size in pixels').fill('3000')
  await page.getByLabel('Y position or size in pixels').press('Enter')
  expect((await geometry(box)).y).toBe(3000)
  const h1 = await surface.evaluate((el) => (el as HTMLElement).offsetHeight)
  expect(h1).toBeGreaterThan(h0)
  expect(h1).toBeGreaterThanOrEqual(3000 + (await geometry(box)).h)
  // Objects cannot leave the page horizontally.
  await page.getByLabel('X position or size in pixels').fill('5000')
  await page.getByLabel('X position or size in pixels').press('Enter')
  const g = await geometry(box)
  expect(g.x + g.w).toBeLessThanOrEqual(1200)
})
