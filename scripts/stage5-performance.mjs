// Reproducible Stage 5 engineering benchmark. Uses only synthetic data and fresh
// Playwright browser contexts; never connects to a real browser profile.
// Serve a production build on a dedicated port, then:
//   node scripts/stage5-performance.mjs http://localhost:4375/
// Optional: MINTY_PERF_LARGE_IMAGES=0 omits the ten 25.75 MiB BMP originals.
// The full default run writes ~1 GiB of temporary fixtures/downloads to /tmp.
import assert from 'node:assert/strict'
import { createHash, randomFillSync, randomUUID } from 'node:crypto'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { zipSync, strToU8 } from 'fflate'
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:4375/'
const largeImages = process.env.MINTY_PERF_LARGE_IMAGES === '0' ? 0 : 10
const dir = mkdtempSync(join(tmpdir(), 'minty-stage5-performance-'))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const now = new Date().toISOString()
const timings = {}
const memory = {}
const errors = []
const report = { date: now, url, machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: +(totalmem() / 1024 ** 3).toFixed(1), node: process.version }, fixture: {}, timings, memory, errors, artifacts: dir }
const browser = await chromium.launch()
report.machine.chromium = browser.version()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(180_000)
page.on('pageerror', (e) => errors.push(e.message))
page.on('dialog', (d) => d.dismiss())
const sessions = new Map()
const installProbe = () => {
  globalThis.__perfGaps = []
  let last = performance.now()
  setInterval(() => {
    const at = performance.now()
    globalThis.__perfGaps.push(at - last)
    last = at
  }, 25)
}
await context.addInitScript(installProbe)

async function measured(name, fn, target = page) {
  await target.evaluate(() => { globalThis.__perfGaps = [] }).catch(() => {})
  const start = performance.now()
  const result = await fn()
  timings[name] = { ms: +(performance.now() - start).toFixed(1), maxTimerGapMs: await target.evaluate(() => +Math.max(0, ...globalThis.__perfGaps).toFixed(1)).catch(() => null) }
  console.log(name, JSON.stringify(timings[name]))
  if (!sessions.has(target)) sessions.set(target, await target.context().newCDPSession(target))
  memory[name] = { ...await sessions.get(target).send('Runtime.getHeapUsage').catch(() => ({})), harnessRss: process.memoryUsage().rss }
  writeFileSync(join(dir, 'results.json'), JSON.stringify(report, null, 2))
  return result
}

const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const projectId = (i) => `perf-project-${i}`
const pageId = (i) => `perf-page-${i}`
const records = {
  workspace: { workspaceId: randomUUID(), formatVersion: 5, createdAt: now },
  projects: Array.from({ length: 50 }, (_, i) => ({ id: projectId(i), name: `Engineering ${String(i).padStart(2, '0')}`, customer: 'Synthetic customer', site: `Station ${i}`, jobNumber: `PERF-${i}`, status: 'active', dueDate: null, description: 'Synthetic engineering benchmark only', contacts: [], equipment: [], software: [], fileLocations: [], categoryIds: [], pinnedPageIds: [], hiddenPageIds: [], noteSort: 'last-edited', order: i + 1, archivedAt: null, trashedAt: null, createdAt: now, updatedAt: now })),
  tasks: Array.from({ length: 1000 }, (_, i) => ({ id: `perf-task-${i}`, projectId: projectId(Math.floor(i / 20)), title: `Check terminal ${i}`, description: `Synthetic task ${i} commissioning checklist`, status: ['todo', 'doing', 'done'][i % 3], priority: ['normal', 'high', 'low', 'urgent'][i % 4], dueDate: null, linkedPageIds: [pageId(i)], order: i + 1, completedAt: i % 3 === 2 ? now : null, createdAt: now, updatedAt: now })),
  templates: [], categories: [], tags: [], notebooks: [], sections: [],
  pages: Array.from({ length: 1000 }, (_, i) => ({ id: pageId(i), title: i === 0 ? 'Demanding page 100 objects 15 images' : `Commissioning note ${String(i).padStart(4, '0')}`, location: { kind: 'project', projectId: projectId(Math.floor(i / 20)) }, order: i % 20 + 1, width: 1200, categoryIds: [], tagIds: [], copiedFrom: null, createdAt: now, updatedAt: now, trashedAt: null })),
  objects: Array.from({ length: 999 }, (_, n) => ({ id: `perf-text-${n + 1}`, pageId: pageId(n + 1), type: 'text', x: 40, y: 40, w: 720, h: 80, z: 1, doc: doc(`Terminal inspection marker-${n + 1}. Record tag, measured voltage, and commissioning result.`), createdAt: now, updatedAt: now })),
  attachments: [],
}
const files = {}
const manifestFiles = []
function attach(bytes, fileName, mimeType, width, height, ownerPage, geometry) {
  const id = randomUUID()
  const hash = sha(bytes)
  records.attachments.push({ id, fileName, mimeType, size: bytes.length, sha256: hash, width, height, source: 'file', createdAt: now })
  const path = `attachments/${id}.${mimeType.split('/')[1]}`
  files[path] = [new Uint8Array(bytes), { level: 0 }]
  manifestFiles.push({ attachmentId: id, path, size: bytes.length, sha256: hash, mimeType })
  records.objects.push({ id: randomUUID(), pageId: ownerPage, type: 'image', attachmentId: id, alt: fileName, ...geometry, createdAt: now, updatedAt: now })
}

// Fifteen real rendered 1200×800 PNGs on the demanding page.
const shooter = await browser.newPage({ viewport: { width: 1200, height: 800 } })
for (let i = 0; i < 15; i++) {
  await shooter.setContent(`<body style="margin:0;font:20px sans-serif;background:hsl(${i * 24} 30% 92%)"><div style="background:#1f6feb;color:#fff;padding:12px">Synthetic HMI ${i + 1}</div>${Array.from({ length: 18 }, (_, r) => `<div style="padding:8px 16px;border-bottom:1px solid #ccc">Tag ${r} — value ${(r * 37 + i) % 101}</div>`).join('')}</body>`)
  attach(await shooter.screenshot(), `HMI-${i}.png`, 'image/png', 1200, 800, pageId(0), { x: 620, y: 40 + i * 420, w: 540, h: 360, z: i + 1 })
}
await shooter.close()
for (let i = 0; i < 85; i++) records.objects.push({ id: `heavy-text-${i}`, pageId: pageId(0), type: 'text', x: 40, y: 40 + i * 150, w: 540, h: 100, z: i + 100, doc: doc(`Step ${i + 1}: Check terminal, confirm the tag, record value. Synthetic engineering note for a demanding page.`), createdAt: now, updatedAt: now })

// Genuine uncompressed 3000×3000 24-bit BMPs, random pixels, each 27,000,054 bytes.
// They are referenced by ordinary pages, so backups and project packages include
// actual imported image bytes rather than dummy ZIP padding or abandoned files.
let docxImage
for (let i = 0; i < Math.max(1, largeImages); i++) {
  const bmp = Buffer.alloc(54 + 3000 * 3000 * 3)
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(3000, 18); bmp.writeInt32LE(3000, 22)
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(bmp.length - 54, 34)
  randomFillSync(bmp, 54)
  if (i === 0) docxImage = bmp
  if (i < largeImages) attach(bmp, `Synthetic-photo-${i}.bmp`, 'image/bmp', 3000, 3000, pageId(i + 1), { x: 40, y: 200, w: 600, h: 600, z: 2 })
}
const recordsBytes = strToU8(JSON.stringify(records))
const counts = Object.fromEntries(['projects', 'tasks', 'templates', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'objects', 'attachments'].map((k) => [k, records[k].length]))
const manifest = { format: 'minty-notes-backup', formatVersion: 5, app: { name: 'Minty Notes', version: '0.5.0-benchmark' }, createdAt: now, workspaceId: records.workspace.workspaceId, counts, records: { path: 'records.json', size: recordsBytes.length, sha256: sha(recordsBytes) }, files: manifestFiles }
files['manifest.json'] = strToU8(JSON.stringify(manifest))
files['records.json'] = recordsBytes
const fixturePath = join(dir, 'engineering.zip')
writeFileSync(fixturePath, zipSync(files))
report.fixture = { ...counts, attachmentBytes: records.attachments.reduce((n, a) => n + a.size, 0), backupBytes: statSync(fixturePath).size, largeImages, heavyObjects: 100, heavyImages: 15 }
console.log('fixture', JSON.stringify(report.fixture), dir)

// Valid large DOCX: one 25.75 MiB BMP plus 2,000 paragraphs, stored image data.
const xml = (s) => strToU8(s)
const para = (s) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`
const docxPath = join(dir, 'Large synthetic manual.docx')
writeFileSync(docxPath, zipSync({
  '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/_rels/document.xml.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.bmp"/></Relationships>'),
  'word/document.xml': xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${Array.from({ length: 2000 }, (_, i) => para(`Manual paragraph ${i + 1}: confirm the terminal tag and record commissioning voltage before proceeding.`)).join('')}<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525000" cy="9525000"/><wp:docPr id="1" name="photo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="photo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`),
  'word/media/photo.bmp': [new Uint8Array(docxImage), { level: 0 }],
}))
report.fixture.docxBytes = statSync(docxPath).size

async function saved(p = page) { await p.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-status') === 'saved') }
async function restore(p, path, prefix) {
  await p.getByTestId('rail-settings').click()
  let start = performance.now()
  await p.getByTestId('restore-file').setInputFiles(path)
  await p.getByTestId('restore-review').waitFor()
  timings[`${prefix}Validation`] = { ms: +(performance.now() - start).toFixed(1) }
  start = performance.now()
  await p.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await p.getByText(`Restored 50 projects, 1000 pages, and ${records.attachments.length} images.`, { exact: false }).waitFor()
  timings[`${prefix}Commit`] = { ms: +(performance.now() - start).toFixed(1) }
  await p.getByRole('button', { name: 'Done', exact: true }).click()
}
async function workspaceDigest(p) {
  return p.evaluate(async () => {
    const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const db = await request(indexedDB.open('minty-notes'))
    const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
    const out = {}
    for (const name of ['projects', 'tasks', 'templates', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'objects', 'attachments']) {
      const all = await request(db.transaction(name).objectStore(name).getAll())
      all.sort((a, b) => a.id.localeCompare(b.id))
      out[name] = { count: all.length, sha256: await digest(new TextEncoder().encode(JSON.stringify(all))) }
    }
    out.blobs = {}
    for (const id of await request(db.transaction('blobs').objectStore('blobs').getAllKeys())) {
      const blob = await request(db.transaction('blobs').objectStore('blobs').get(id))
      out.blobs[id] = await digest(await blob.arrayBuffer())
    }
    db.close()
    return out
  })
}

try {
  await measured('emptyStartup', async () => { await page.goto(url); await page.getByTestId('rail-settings').waitFor() })
  await measured('initialFixtureRestore', () => restore(page, fixturePath, 'initialRestore'))
  await measured('workspaceStartup', async () => { await page.reload(); await page.getByTestId('rail-settings').waitFor(); await saved() })
  await measured('projectNavigation', async () => { await page.getByTestId('rail-projects').click(); await page.getByRole('button', { name: /^Engineering 00 / }).click(); await page.getByTestId('project-view').waitFor() })
  await measured('searchPreparationAndQuery', async () => { await page.getByTestId('rail-search').click(); await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('marker-777'); await page.getByTestId('search-results').getByRole('button').first().waitFor() })
  await measured('indexedSearchQuery', async () => { await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('marker-888'); await page.getByTestId('search-results').getByText(/Commissioning note 0888/).waitFor() })
  await page.getByTestId('rail-projects').click()
  await page.getByTestId('project-nav-overview').click()
  await measured('heavyPageOpen', async () => { await page.locator('.navigator .nav-page').filter({ hasText: 'Demanding page 100 objects' }).click(); await page.locator('.obj').nth(99).waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.obj-image img')].every((i) => i.complete && i.naturalWidth > 0)) })
  assert.equal(await page.locator('.obj').count(), 100)
  assert.equal(await page.locator('.obj-image').count(), 15)
  await saved()
  await page.locator('.obj-text').first().locator('.rt').click()
  await measured('typing20Characters', () => page.keyboard.type('abcdefghijklmnopqrst'))
  await page.keyboard.press('Escape')
  const grip = await page.locator('.obj-text').first().locator('.obj-grip').boundingBox()
  await page.mouse.move(grip.x + 10, grip.y + 5); await page.mouse.down()
  await measured('drag40Moves', async () => { for (let i = 1; i <= 40; i++) await page.mouse.move(grip.x + 10 + i * 2, grip.y + 5 + i) })
  await page.mouse.up()
  await saved()
  const before = await workspaceDigest(page)
  await page.getByTestId('rail-settings').click()
  const backupPath = join(dir, 'downloaded-backup.zip')
  await measured('backupDownload', async () => { const dl = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download backup', exact: true }).click(); await (await dl).saveAs(backupPath) })
  report.fixture.downloadedBackupBytes = statSync(backupPath).size
  const restoredContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await restoredContext.addInitScript(installProbe)
  const restored = await restoredContext.newPage(); restored.setDefaultTimeout(180_000)
  await restored.goto(url); await restored.getByTestId('rail-settings').waitFor()
  await measured('cleanWorkspaceRestore', () => restore(restored, backupPath, 'cleanRestore'), restored)
  assert.deepEqual(await workspaceDigest(restored), before, 'Every record and every attachment SHA-256 must round trip')
  report.fullBackupRoundTrip = 'Every record table digest and all attachment SHA-256 values match'
  await restoredContext.close()
  await page.getByTestId('rail-projects').click(); await page.getByTestId('project-nav-overview').click()
  await measured('projectExportPreview', async () => { await page.getByTestId('export-project').click(); await page.getByTestId('export-download').waitFor({ state: 'visible' }); await page.getByTestId('export-download').isEnabled() })
  const packagePath = join(dir, 'project-package.zip')
  await measured('projectPackageBuildAndVerify', async () => { const dl = page.waitForEvent('download'); await page.getByTestId('export-download').click(); await (await dl).saveAs(packagePath); await page.getByTestId('export-done').waitFor() })
  report.fixture.projectPackageBytes = statSync(packagePath).size
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const importContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await importContext.addInitScript(installProbe)
  const imported = await importContext.newPage(); imported.setDefaultTimeout(180_000)
  await imported.goto(url); await imported.getByTestId('rail-projects').click()
  await measured('projectPackageValidation', async () => { await imported.getByTestId('import-project-file').first().setInputFiles(packagePath); await imported.getByTestId('import-review').waitFor() }, imported)
  await measured('projectPackageImport', async () => { await imported.getByTestId('import-confirm').click(); await imported.getByTestId('import-done').waitFor() }, imported)
  const importedDigest = await workspaceDigest(imported)
  assert.equal(importedDigest.projects.count, 1); assert.equal(importedDigest.pages.count, 20); assert.equal(importedDigest.tasks.count, 20); assert.equal(importedDigest.attachments.count, records.attachments.length)
  assert.deepEqual(Object.values(importedDigest.blobs).sort(), Object.values(before.blobs).sort())
  report.projectRoundTrip = '20 notes, 20 tasks, every project attachment hash matches; fresh IDs checked by existing portability suite'
  await importContext.close()
  await page.getByTestId('rail-inbox').click()
  await measured('largeDocxImport', async () => { await page.getByTestId('import-file').first().setInputFiles(docxPath); await page.locator('.page-title').waitFor(); await page.waitForFunction(() => document.querySelector('.page-title')?.value === 'Large synthetic manual'); await page.locator('.obj-image img').waitFor(); await saved() })
  report.docx = { textBoxes: await page.locator('.obj-text').count(), images: await page.locator('.obj-image').count() }
  assert.equal(report.docx.images, 1)
  await page.screenshot({ path: join(dir, 'large-docx.png') })
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(dir, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
