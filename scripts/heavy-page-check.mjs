// Builds a backup with one demanding page (85 text boxes + 15 large screenshots),
// restores it through the real UI of a running build, and times opening and dragging.
// Usage: npm run build && npx vite preview --port 4173 &  then  node scripts/heavy-page-check.mjs [url]
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:4173/'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const now = new Date().toISOString()
const browser = await chromium.launch()

// 15 realistic 1200×800 screenshots.
const shooter = await browser.newPage({ viewport: { width: 1200, height: 800 } })
const images = []
for (let i = 0; i < 15; i++) {
  await shooter.setContent(`<body style="margin:0;font:20px sans-serif;background:hsl(${i * 24} 30% 92%)">
    <div style="background:#1f6feb;color:#fff;padding:12px">Screen ${i + 1}</div>
    ${Array.from({ length: 18 }, (_, r) => `<div style="padding:8px 16px;border-bottom:1px solid #ccc">Row ${r} — value ${(r * 37 + i) % 101}</div>`).join('')}</body>`)
  images.push(await shooter.screenshot())
}
await shooter.close()

const pageId = randomUUID()
const records = {
  workspace: { workspaceId: randomUUID(), formatVersion: 1, createdAt: now },
  notebooks: [],
  sections: [],
  pages: [{ id: pageId, title: 'Demanding page (100 objects, 15 images)', location: { kind: 'inbox' }, order: 1, width: 1200, createdAt: now, updatedAt: now, trashedAt: null }],
  objects: [],
  attachments: [],
}
const files = {}
const manifestFiles = []
images.forEach((bytes, i) => {
  const id = randomUUID()
  records.attachments.push({ id, fileName: `shot-${i}.png`, mimeType: 'image/png', size: bytes.length, sha256: sha(bytes), width: 1200, height: 800, source: 'paste', createdAt: now })
  const path = `attachments/${id}.png`
  files[path] = [new Uint8Array(bytes), { level: 0 }]
  manifestFiles.push({ attachmentId: id, path, size: bytes.length, sha256: sha(bytes), mimeType: 'image/png' })
  records.objects.push({ id: randomUUID(), pageId, type: 'image', attachmentId: id, alt: '', x: 620, y: 40 + i * 420, w: 540, h: 360, z: i + 1, createdAt: now, updatedAt: now })
})
for (let i = 0; i < 85; i++) {
  records.objects.push({
    id: randomUUID(), pageId, type: 'text', x: 40, y: 40 + i * 150, w: 540, h: 120, z: 100 + i, createdAt: now, updatedAt: now,
    doc: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: `Step ${i + 1}` }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Check the terminal, confirm the tag, and note the value. ' }, { type: 'text', marks: [{ type: 'bold' }], text: 'Do not energize.' }] },
    ] },
  })
}
const recordsBytes = strToU8(JSON.stringify(records))
const manifest = {
  format: 'minty-notes-backup', formatVersion: 1, app: { name: 'Minty Notes', version: 'fixture' }, createdAt: now,
  workspaceId: records.workspace.workspaceId,
  counts: { notebooks: 0, sections: 0, pages: 1, objects: 100, attachments: 15 },
  records: { path: 'records.json', size: recordsBytes.length, sha256: sha(recordsBytes) },
  files: manifestFiles,
}
files['manifest.json'] = strToU8(JSON.stringify(manifest))
files['records.json'] = recordsBytes
const dir = mkdtempSync(join(tmpdir(), 'minty-heavy-'))
const zipPath = join(dir, 'heavy.zip')
writeFileSync(zipPath, zipSync(files))

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
await page.goto(url)
await page.getByRole('button', { name: 'Settings' }).click()
await page.getByTestId('restore-file').setInputFiles(zipPath)
await page.getByRole('button', { name: 'Replace workspace' }).click()
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('button', { name: 'Inbox' }).click()

let t = Date.now()
await page.locator('.nav-page').first().click()
await page.locator('.obj').nth(99).waitFor({ state: 'attached' })
const openMs = Date.now() - t
await page.waitForFunction(() => [...document.querySelectorAll('.obj-image img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 3)
const editors = await page.locator('.ProseMirror').count()

const box = page.locator('.obj-text').first()
const grip = (await box.locator('.obj-grip').boundingBox()) ?? (await box.boundingBox())
await page.mouse.move(grip.x + 10, grip.y + 5)
await page.mouse.down()
t = Date.now()
for (let i = 1; i <= 40; i++) await page.mouse.move(grip.x + 10 + i * 4, grip.y + 5 + i * 2)
const dragMs = (Date.now() - t) / 40
await page.mouse.up()

await box.locator('.rt').click()
t = Date.now()
await page.keyboard.type('abcdefghijklmnopqrst')
const typeMs = (Date.now() - t) / 20

console.log(JSON.stringify({ openMs, editors, avgPointerMoveMs: +dragMs.toFixed(1), avgKeystrokeMs: +typeMs.toFixed(1) }))
await browser.close()
