import { expect, type Locator, type Page } from '@playwright/test'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Object geometry in page coordinates, read from its inline style. */
export async function geometry(obj: Locator): Promise<Box> {
  return obj.evaluate((el) => {
    const s = (el as HTMLElement).style
    return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: el.getBoundingClientRect().height }
  }) as Promise<Box>
}

/** Current zoom scale of the page surface. */
export async function pageScale(page: Page): Promise<number> {
  return page.getByTestId('page-surface').evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth)
}

/**
 * Put a generated PNG on the system clipboard (Chromium's real async clipboard)
 * and paste it with the keyboard, like a screenshot tool followed by Ctrl+V.
 */
export async function pasteScreenshot(page: Page, label = 'SCREENSHOT', size = { w: 480, h: 280 }): Promise<void> {
  await page.evaluate(
    async ({ label, size }) => {
      const c = document.createElement('canvas')
      c.width = size.w
      c.height = size.h
      const g = c.getContext('2d')!
      g.fillStyle = '#2b3442'
      g.fillRect(0, 0, size.w, size.h)
      g.fillStyle = '#6ee7b7'
      g.fillRect(16, 16, size.w / 2, size.h / 3)
      g.fillStyle = '#ffffff'
      g.font = '28px sans-serif'
      g.fillText(label, 24, size.h - 40)
      const blob = await new Promise<Blob>((r) => c.toBlob((b: Blob | null) => r(b!), 'image/png'))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    },
    { label, size },
  )
  await page.keyboard.press('ControlOrMeta+V')
}

export async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved')
}

/** SHA-256 of the bytes behind an <img> (blob URL). */
export async function imageHash(img: Locator): Promise<string> {
  return img.evaluate(async (el) => {
    const res = await fetch((el as HTMLImageElement).src)
    const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer())
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  })
}

export async function newQuickNote(page: Page): Promise<void> {
  await page.getByTestId('quick-note').click()
  await expect(page.getByTestId('page-surface')).toBeVisible()
}

export async function addTextBox(page: Page, text: string): Promise<Locator> {
  const before = await page.locator('.obj-text').count()
  await page.getByRole('button', { name: 'Add text box' }).click()
  await expect(page.locator('.obj-text')).toHaveCount(before + 1)
  await page.keyboard.type(text)
  return page.locator('.obj-text').filter({ hasText: text })
}

export async function dragBy(page: Page, from: Locator, dx: number, dy: number): Promise<void> {
  const b = (await from.boundingBox())!
  const sx = b.x + b.width / 2
  const sy = b.y + b.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + dx / 3, sy + dy / 3, { steps: 4 })
  await page.mouse.move(sx + dx, sy + dy, { steps: 6 })
  await page.mouse.up()
}
