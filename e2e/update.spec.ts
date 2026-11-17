import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { expect, test } from '@playwright/test'
import { addTextBox, newQuickNote, waitSaved } from './helpers'

test('a changed build with the same version waits for a successful save before updating', async ({ browser }) => {
  const root = resolve(process.env.E2E_OUT_DIR || 'dist')
  let generation = 1
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, 'http://localhost').pathname
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return }
      const content = await readFile(file)
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(pathname === '/sw.js' ? Buffer.concat([content, Buffer.from(`\n// isolated update generation ${generation}`)]) : content)
    } catch { res.writeHead(404).end() }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await expect(page.getByTestId('offline-pill')).toHaveText(/Offline ready/)
    await newQuickNote(page)
    await addTextBox(page, 'Saved before build update')
    await waitSaved(page)
    generation++
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg!.update() })
    const update = page.getByRole('button', { name: 'Save and update', exact: true })
    await expect(update).toBeVisible()
    await expect(page.getByText('An updated app build is ready. The version number may be unchanged.')).toBeVisible()
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put
      ;(window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = original }
      IDBObjectStore.prototype.put = function () { throw new DOMException('Simulated full disk', 'QuotaExceededError') }
    })
    await addTextBox(page, 'Unsaved edit must survive update refusal')
    await expect(page.getByTestId('save-error-banner')).toBeVisible()
    await update.click()
    await expect(page.getByText('Changes could not be saved, so the update was postponed.')).toBeVisible()
    await expect(update).toBeVisible()
    await expect(page.locator('.obj-text').last()).toContainText('Unsaved edit must survive update refusal')
    await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut())
    await update.click()
    await expect(update).toHaveCount(0)
    await expect(page.locator('.obj-text').last()).toContainText('Unsaved edit must survive update refusal')
    await waitSaved(page)
  } finally {
    await context.close()
    await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()))
  }
})
