import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import { addTextBox, newQuickNote, waitSaved } from './helpers'

interface ZipProbe {
  created: number
  readies: number
  posts: number
  /** SHA-256 (hex) of each archive the ZIP worker itself returned. */
  replies: string[]
}

/**
 * Wrap the page's Worker constructor (test instrumentation only; the app is
 * unchanged) to observe the real ZIP worker: its ready message, the files
 * handed to it, and the bytes it returns. With `crashAfterReady`, the files
 * are not forwarded and a runtime error is raised instead, as if the worker
 * died during construction.
 */
async function probeZipWorker(page: Page, crashAfterReady = false) {
  await page.addInitScript((crash) => {
    const probe = { created: 0, readies: 0, posts: 0, replies: [] as string[] }
    ;(window as unknown as { __zipProbe: typeof probe }).__zipProbe = probe
    const Native = window.Worker
    window.Worker = class extends Native {
      private readonly zip: boolean
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.zip = String(url).includes('archiveZipWorker')
        if (!this.zip) return
        probe.created++
        this.addEventListener('message', (e: MessageEvent) => {
          if (e.data?.ready) probe.readies++
          if (e.data?.ok && e.data.bytes) {
            const copy = (e.data.bytes as Uint8Array).slice()
            void crypto.subtle.digest('SHA-256', copy).then((d) => probe.replies.push([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')))
          }
        })
      }
      postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
        if (!this.zip) return super.postMessage(message, options as StructuredSerializeOptions)
        probe.posts++
        if (crash) {
          setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'Simulated worker crash', cancelable: true })), 50)
          return
        }
        return super.postMessage(message, options as StructuredSerializeOptions)
      }
    }
  }, crashAfterReady)
}

const probe = (page: Page) => page.evaluate(() => (window as unknown as { __zipProbe: ZipProbe }).__zipProbe)

async function noteToBackUp(page: Page, text: string) {
  await newQuickNote(page)
  await addTextBox(page, text)
  await waitSaved(page)
  await page.getByTestId('rail-settings').click()
}

test('backup ZIP worker is cached and itself builds the downloaded archive offline', async ({ page, context }) => {
  await probeZipWorker(page)
  await page.goto('/')
  await expect(page.getByTestId('offline-pill')).toContainText('Offline ready')
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await context.setOffline(true)
  await noteToBackUp(page, 'Archive worker offline verification')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download backup', exact: true }).click()
  const bytes = await readFile((await (await download).path())!)
  await expect.poll(async () => (await probe(page)).replies.length).toBe(1)
  const seen = await probe(page)
  expect(seen).toMatchObject({ created: 1, readies: 1, posts: 1 })
  // The downloaded file is exactly the archive the worker returned.
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(seen.replies[0])
  const files = unzipSync(bytes)
  const records = JSON.parse(strFromU8(files['records.json'])) as { pages: unknown[]; objects: { doc?: unknown }[] }
  expect(records.pages).toHaveLength(1)
  expect(JSON.stringify(records.objects)).toContain('Archive worker offline verification')
  expect(files['manifest.json']).toBeDefined()
})

test('a ZIP worker crash after startup fails the backup without rebuilding it on the main thread', async ({ page }) => {
  await probeZipWorker(page, true)
  await page.goto('/')
  await noteToBackUp(page, 'Crash during archive construction')
  let downloads = 0
  page.on('download', () => downloads++)
  const button = page.getByRole('button', { name: 'Download backup', exact: true })
  await button.click()
  await expect(page.getByText(/background archive writer stopped unexpectedly/).first()).toBeVisible()
  await expect(button).toBeEnabled()
  expect(await probe(page)).toMatchObject({ created: 1, readies: 1, posts: 1, replies: [] })
  // Give any (incorrect) fallback build time to finish and start a download.
  await page.waitForTimeout(1000)
  expect(downloads).toBe(0)
})

test('a ZIP worker that cannot load falls back to the main thread and still downloads a complete backup', async ({ browser, baseURL }) => {
  // No service worker, so the blocked module request reaches the route.
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' })
  const page = await context.newPage()
  try {
    await probeZipWorker(page)
    await page.route(/archiveZipWorker/, (route) => route.fulfill({ status: 404, body: 'blocked for test' }))
    await page.goto('/')
    await noteToBackUp(page, 'Startup failure fallback')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download backup', exact: true }).click()
    const files = unzipSync(await readFile((await (await download).path())!))
    expect(JSON.stringify(JSON.parse(strFromU8(files['records.json'])).objects)).toContain('Startup failure fallback')
    expect(await probe(page)).toMatchObject({ created: 1, readies: 0, posts: 0, replies: [] })
  } finally { await context.close() }
})
