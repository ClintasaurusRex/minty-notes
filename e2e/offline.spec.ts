import { expect, test } from '@playwright/test'
import { addTextBox, newQuickNote, pasteScreenshot, waitSaved } from './helpers'

test('after one online visit the app opens and works offline', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByTestId('offline-pill')).toHaveText(/Offline ready/)
  await newQuickNote(page)
  await addTextBox(page, 'Written before going offline')
  await pasteScreenshot(page)
  await expect(page.locator('.obj-image img')).toBeVisible()
  await waitSaved(page)

  // Every app file the worker precached is really in the cache.
  const missing = await page.evaluate(async () => {
    const sw = await (await fetch('./sw.js')).text()
    const list = JSON.parse(sw.match(/const ASSETS = (\[.*\])/)![1]) as string[]
    const keys = await caches.keys()
    const cache = await caches.open(keys.find((k) => k.startsWith('minty-notes-app-'))!)
    const out: string[] = []
    for (const url of list) if (!(await cache.match(new URL(url, location.href).href))) out.push(url)
    return out
  })
  expect(missing).toEqual([])

  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.obj-text')).toHaveText('Written before going offline')
  await expect.poll(() => page.locator('.obj-image img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

  // Editing and saving still work offline (storage is local).
  await addTextBox(page, 'Written offline')
  await waitSaved(page)
  const another = await context.newPage()
  await another.goto('/')
  await expect(another.locator('.rail')).toBeVisible()
  await context.setOffline(false)
})
