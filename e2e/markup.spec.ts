import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { geometry, imageHash, newQuickNote, waitSaved } from './helpers'

/**
 * A synthetic HMI screenshot (480 × 280): dark background, a mint panel, and a
 * magenta "password" block at (300, 40)–(400, 90) that must not survive redaction.
 */
async function pasteHmiScreenshot(page: Page) {
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
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.locator('.obj-image img')).toHaveCount(1)
}

/** Screen position of a point in markup coordinates (the editor's SVG). */
async function toClient(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const [cx, cy] = await page.locator('.markup-svg').evaluate((svg, [px, py]) => {
    const p = new DOMPoint(px, py).matrixTransform((svg as SVGSVGElement).getScreenCTM()!)
    return [p.x, p.y]
  }, [x, y])
  return { x: cx, y: cy }
}

async function drag(page: Page, from: [number, number], to: [number, number], via: [number, number][] = []) {
  const a = await toClient(page, ...from)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (const p of via) {
    const v = await toClient(page, ...p)
    await page.mouse.move(v.x, v.y, { steps: 3 })
  }
  const b = await toClient(page, ...to)
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.mouse.up()
}

const items = (page: Page) => page.locator('.markup-svg [data-id]')
/** SHA-256 of the image bytes shown on the page (plain <img>, or the <image> under the markup). */
async function shownImageHash(page: Page): Promise<string> {
  return page.locator('.obj-image').evaluate(async (el) => {
    const plain = el.querySelector('img')
    const svgImage = el.querySelector('svg image')
    const src = plain ? plain.src : (svgImage as SVGImageElement).href.baseVal
    const res = await fetch(src)
    const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer())
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  })
}
/** The page's marked-up SVG, without the per-session blob URL of the image. */
const svgOf = async (page: Page) => (await page.locator('.obj-image .markup-view').innerHTML()).replace(/blob:[^"]+/g, 'blob:')

test('screenshot markup: every tool, keyboard, crop, undo, PNG copy with real redaction, reload, and clean restore', async ({ page, browser }, testInfo) => {
  await page.goto('/')
  await newQuickNote(page)
  await page.getByLabel('Page title').fill('Lift station HMI')
  await pasteHmiScreenshot(page)
  const image = page.locator('.obj-image')
  const originalHash = await imageHash(image.locator('img'))
  const before = await geometry(image)

  // Open the editor from the floating "Mark up" button.
  await image.click()
  await page.getByRole('button', { name: /^Mark up:/ }).click()
  const editor = page.getByTestId('markup-editor')
  await expect(editor).toBeVisible()
  await expect(editor.locator('.markup-svg image')).toHaveCount(1)

  // Arrow (default tool), rectangle, ellipse, line, pen, highlighter.
  await drag(page, [40, 160], [150, 110])
  await expect(items(page)).toHaveCount(1)
  await page.keyboard.press('r')
  await drag(page, [20, 190], [240, 240])
  await page.keyboard.press('e')
  await drag(page, [250, 120], [330, 170])
  await page.keyboard.press('l')
  await drag(page, [20, 260], [460, 260])
  await page.keyboard.press('p')
  await drag(page, [420, 150], [460, 200], [[430, 170], [445, 160]])
  await page.keyboard.press('h')
  await drag(page, [20, 225], [200, 225])
  await expect(items(page)).toHaveCount(6)

  // Text label: click, type, Enter.
  await page.keyboard.press('t')
  const at = await toClient(page, 160, 30)
  await page.mouse.click(at.x, at.y)
  await page.getByLabel('Label text').fill('Fault bit B3:0/4')
  await page.getByLabel('Label text').press('Enter')
  await expect(editor.locator('.markup-svg text')).toContainText('Fault bit B3:0/4')

  // Redaction box over the magenta "password", and a blur area.
  await page.keyboard.press('x')
  await expect(editor.locator('.markup-hint')).toContainText('original screenshot is still stored')
  await drag(page, [295, 35], [405, 95])
  await page.keyboard.press('b')
  await expect(editor.locator('.markup-hint')).toContainText('Blur is visual only')
  await drag(page, [20, 200], [250, 235])
  await expect(items(page)).toHaveCount(9)

  // Keyboard: select with Tab, move with arrows, delete, undo.
  await page.keyboard.press('v')
  await page.keyboard.press('Escape') // deselects the newest annotation (does not close)
  await expect(editor).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(editor.locator('[role=status]')).toContainText('Arrow')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Delete')
  await expect(items(page)).toHaveCount(8)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(items(page)).toHaveCount(9)
  // Keyboard-only drawing: choose a tool and press Enter to add one in the middle.
  await page.keyboard.press('r')
  await page.keyboard.press('Enter')
  await expect(items(page)).toHaveCount(10)
  await page.keyboard.press('Alt+ArrowRight')
  await page.keyboard.press('Delete')
  await expect(items(page)).toHaveCount(9)

  // Crop away the bottom strip (keyboard: Alt+↑ shrinks the crop height).
  await page.keyboard.press('c')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Alt+ArrowUp')
  await page.keyboard.press('v')
  await editor.getByTestId('markup-done').click()
  await expect(editor).toBeHidden()

  // On the page: the marked-up view, smaller height (crop), original bytes untouched.
  await expect(image.locator('.markup-view')).toBeVisible()
  const after = await geometry(image)
  expect(after.w).toBe(before.w)
  expect(after.h).toBeLessThan(before.h)
  expect(await shownImageHash(page)).toBe(originalHash)
  // The marked-up view fills the object frame (nothing else is drawn in it).
  const frame = (await image.boundingBox())!
  const view = (await image.locator('.markup-view').boundingBox())!
  expect(Math.abs(view.height - frame.height)).toBeLessThan(2)
  expect(Math.abs(view.y - frame.y)).toBeLessThan(2)

  // One page-level undo step removes the markup; redo restores it.
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(image.locator('.markup-view')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(image.locator('.markup-view')).toBeVisible()

  // Flattened PNG copy: the redacted pixels are solid black; no magenta remains anywhere.
  await image.click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /^Save a flattened PNG copy/ }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\(marked up\)\.png$/)
  const pngPath = testInfo.outputPath('marked.png')
  await download.saveAs(pngPath)
  const png = readFileSync(pngPath).toString('base64')
  const check = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    const data = g.getImageData(0, 0, bmp.width, bmp.height).data
    let magenta = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] > 200) magenta++
    const px = g.getImageData(350, 65, 1, 1).data
    return { w: bmp.width, h: bmp.height, magenta, centre: [px[0], px[1], px[2], px[3]] }
  }, png)
  expect(check.w).toBe(480)
  expect(check.h).toBeLessThan(280)
  expect(check.magenta).toBe(0)
  expect(check.centre).toEqual([0, 0, 0, 255])

  // The markup is still editable: reopen with Enter and see every annotation.
  await image.focus()
  await page.keyboard.press('Enter')
  await expect(editor).toBeVisible()
  await expect(items(page)).toHaveCount(9)
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toBeHidden()

  // Reload: unchanged.
  await waitSaved(page)
  const svgBefore = await svgOf(page)
  await page.reload()
  await expect(page.locator('.obj-image .markup-view')).toBeVisible()
  expect(await svgOf(page)).toBe(svgBefore)

  // Backup → restore in a clean browser context: markup and the original image bytes.
  await page.getByRole('button', { name: 'Settings' }).click()
  const backupDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup' }).click()
  const backupPath = testInfo.outputPath('markup-backup.zip')
  await (await backupDownload).saveAs(backupPath)
  const clean = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fresh = await clean.newPage()
  await fresh.goto('/')
  await fresh.getByRole('button', { name: 'Settings' }).click()
  await fresh.getByTestId('restore-file').setInputFiles(backupPath)
  await expect(fresh.getByTestId('restore-review')).toContainText('passed every check')
  await fresh.getByRole('button', { name: 'Replace workspace' }).click()
  await fresh.getByRole('button', { name: 'Done' }).click()
  await fresh.getByRole('button', { name: 'Inbox' }).click()
  await fresh.locator('.nav-page', { hasText: 'Lift station HMI' }).click()
  await expect(fresh.locator('.obj-image .markup-view')).toBeVisible()
  expect(await svgOf(fresh)).toBe(svgBefore)
  expect(await shownImageHash(fresh)).toBe(originalHash)
  await clean.close()
})

test('sketches: keyboard drawing, labels, an empty new sketch is discarded, and sketches persist', async ({ page }) => {
  await page.goto('/')
  await newQuickNote(page)
  await page.getByLabel('Page title').fill('Panel wiring sketch')

  // A new sketch that is cancelled while empty disappears.
  await page.getByRole('button', { name: /Add a sketch/ }).click()
  const editor = page.getByTestId('markup-editor')
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('button', { name: /Redact/ })).toHaveCount(0) // image-only tools are hidden
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
  await expect(page.locator('.obj-sketch')).toHaveCount(0)

  // Draw with the keyboard only: line, rectangle, a label.
  await page.getByRole('button', { name: /Add a sketch/ }).click()
  await page.keyboard.press('l')
  await page.keyboard.press('Enter')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('r')
  await page.keyboard.press('Enter')
  await page.keyboard.press('t')
  await page.keyboard.press('Enter')
  await page.getByLabel('Label text').fill('X2:14 → K1 coil')
  await page.getByLabel('Label text').press('Enter')
  await expect(items(page)).toHaveCount(3)
  // And a freehand pen stroke with the mouse.
  await page.keyboard.press('p')
  await drag(page, [100, 300], [300, 320], [[150, 280], [220, 340]])
  await expect(items(page)).toHaveCount(4)
  await editor.getByTestId('markup-done').click()
  const sketch = page.locator('.obj-sketch')
  await expect(sketch).toHaveCount(1)
  await expect(sketch).toHaveAttribute('aria-label', /Sketch: X2:14 → K1 coil/)

  // Search finds the label text.
  await waitSaved(page)
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('searchbox', { name: 'Search' }).fill('K1 coil')
  await expect(page.locator('.search-results, [data-testid=search-results]').first()).toContainText('Panel wiring sketch')

  await page.reload()
  await page.getByRole('button', { name: 'Inbox' }).click()
  await page.locator('.nav-page', { hasText: 'Panel wiring sketch' }).click()
  await expect(page.locator('.obj-sketch .markup-view text')).toContainText('X2:14 → K1 coil')
  await expect(page.locator('.obj-sketch .markup-view polyline')).toHaveCount(1)
})
