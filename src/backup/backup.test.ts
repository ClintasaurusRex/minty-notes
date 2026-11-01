import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { docFromPlainText } from '../domain/richtext'
import { newId, nowIso, type ImageObject, type TextObject } from '../domain/types'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { buildArchive, readArchive, sha256Hex } from './archive'
import { BackupService } from './backupService'
import { isSnapshotName, snapshotFileName } from './folder'

/** Simulated directory handle. It exercises our logic, not Chrome's real permission UI. */
class FakeDir {
  name = 'Dropbox Backups'
  files = new Map<string, Uint8Array>()
  permission: PermissionState = 'granted'
  requestResult: PermissionState = 'granted'
  failWrite: Error | null = null
  async queryPermission() {
    return this.permission
  }
  async requestPermission() {
    this.permission = this.requestResult
    return this.permission
  }
  async *keys() {
    yield* [...this.files.keys()]
  }
  async removeEntry(name: string) {
    this.files.delete(name)
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (this.permission !== 'granted') throw new DOMException('denied', 'NotAllowedError')
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('missing', 'NotFoundError')
      this.files.set(name, new Uint8Array())
    }
    return {
      createWritable: async () => {
        let pending: Uint8Array | null = null
        return {
          write: async (b: Uint8Array) => {
            if (this.failWrite) throw this.failWrite
            pending = b
          },
          close: async () => {
            this.files.set(name, pending ?? new Uint8Array())
          },
          abort: async () => undefined,
        }
      },
      getFile: async () => new Blob([this.files.get(name)! as Uint8Array<ArrayBuffer>]),
    }
  }
}

async function sampleWorkspace() {
  const { store } = await freshStore()
  const { notebook, section } = store.createNotebook('Studio 5000')
  const page = store.createPage({ kind: 'inbox' })
  const filed = store.createPage({ kind: 'section', sectionId: section.id }, 'Rack layout')
  const at = nowIso()
  const text: TextObject = { id: newId(), pageId: page.id, type: 'text', x: 48, y: 48, w: 420, h: 72, z: 1, doc: docFromPlainText('Remember the VFD fault code'), createdAt: at, updatedAt: at }
  const attachmentId = newId()
  await store.addAttachment(
    { id: attachmentId, fileName: 'screenshot.png', mimeType: 'image/png', size: PNG_1x1.byteLength, sha256: await sha256Hex(PNG_1x1), width: 1, height: 1, source: 'paste', createdAt: at },
    new Blob([PNG_1x1], { type: 'image/png' }),
  )
  const image: ImageObject = { id: newId(), pageId: page.id, type: 'image', attachmentId, alt: '', x: 520, y: 160, w: 300, h: 200, z: 2, createdAt: at, updatedAt: at }
  store.addObjects(page.id, [text, image])
  await store.flush()
  return { store, notebook, section, page, filed, text, image, attachmentId }
}

function serviceFor(store: Awaited<ReturnType<typeof freshStore>>['store'], dir?: FakeDir) {
  const downloads: { bytes: Uint8Array; fileName: string }[] = []
  const service = new BackupService(store, {
    appVersion: 'test',
    folderSupported: true,
    pickFolder: async () => (dir ?? null) as unknown as FileSystemDirectoryHandle | null,
    download: (bytes, fileName) => downloads.push({ bytes, fileName }),
  })
  return { service, downloads }
}

describe('complete backup and restore', () => {
  it('restores notes, image bytes, layout, and notebook links into a clean workspace', async () => {
    const src = await sampleWorkspace()
    const { service, downloads } = serviceFor(src.store)
    await service.init()
    const result = await service.downloadBackup()
    expect(result.ok).toBe(true)
    expect(downloads).toHaveLength(1)

    const validated = await readArchive(downloads[0].bytes)
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.summary.counts).toEqual({ notebooks: 1, sections: 1, pages: 2, objects: 2, attachments: 1 })

    // Clean workspace in a separate database.
    const clean = await freshStore()
    expect(Object.keys(clean.store.getState().data.pages)).toHaveLength(0)
    const target = serviceFor(clean.store)
    await target.service.init()
    await target.service.restore(validated)

    const data = clean.store.getState().data
    expect(data.workspace?.workspaceId).toBe(src.store.getState().data.workspace?.workspaceId)
    expect(data.pages[src.filed.id].location).toEqual({ kind: 'section', sectionId: src.section.id })
    expect(data.sections[src.section.id].notebookId).toBe(src.notebook.id)
    const objects = await clean.store.ensurePageObjects(src.page.id)
    expect(objects[src.text.id]).toMatchObject({ x: 48, y: 48, w: 420 })
    expect((objects[src.text.id] as TextObject).doc).toEqual(src.text.doc)
    expect(objects[src.image.id]).toMatchObject({ x: 520, y: 160, w: 300, h: 200, attachmentId: src.attachmentId })
    const blob = await clean.store.getBlob(src.attachmentId)
    expect(await sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(await sha256Hex(PNG_1x1))
    // The (empty) previous workspace was kept as a safeguard.
    expect(target.service.getState().safeguard?.fileName).toMatch(/^minty-notes-before-restore-/)
  })

  it('leaves the existing workspace untouched when applying a restore fails', async () => {
    const src = await sampleWorkspace()
    const { bytes } = await serviceFor(src.store).service.createArchive()
    const validated = await readArchive(bytes)
    if (!validated.ok) throw new Error('expected valid')

    const target = await freshStore()
    const existing = target.store.createPage({ kind: 'standalone' }, 'Keep me')
    await target.store.flush()
    const { service } = serviceFor(target.store)
    await service.init()
    vi.spyOn(target.repo, 'replaceAll').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
    await expect(service.restore(validated)).rejects.toThrow()
    await target.store.load()
    expect(target.store.getState().data.pages[existing.id]?.title).toBe('Keep me')
    expect(target.store.getState().data.pages[src.page.id]).toBeUndefined()
  })
})

describe('archive validation', () => {
  async function validArchiveFiles() {
    const src = await sampleWorkspace()
    const { records, blobs } = await src.store.repository.readAll()
    return { src, records, blobs }
  }

  it('rejects files that are not backups', async () => {
    const notZip = await readArchive(strToU8('hello'))
    expect(notZip.ok).toBe(false)
    const noManifest = await readArchive(zipSync({ 'other.txt': strToU8('x') }))
    expect(noManifest).toMatchObject({ ok: false })
    const wrongFormat = await readArchive(zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'something-else' })) }))
    expect(wrongFormat).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a Minty Notes backup/)] })
    const truncated = await readArchive(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]))
    expect(truncated.ok).toBe(false)
  })

  it('rejects backups from a newer format version', async () => {
    const result = await readArchive(zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'minty-notes-backup', formatVersion: 99 })) }))
    expect(result).toMatchObject({ ok: false, errors: [expect.stringMatching(/newer version/)] })
  })

  it('detects tampered records and damaged attachments', async () => {
    const { records, blobs } = await validArchiveFiles()
    const good = await buildArchive(records, blobs, 'test')
    const { unzipSync } = await import('fflate')
    const files = unzipSync(good)

    const tampered = { ...files, 'records.json': strToU8(new TextDecoder().decode(files['records.json']).replace('Studio 5000', 'Studio 9000')) }
    expect(await readArchive(zipSync(tampered))).toMatchObject({ ok: false, errors: [expect.stringMatching(/checksum/)] })

    const imagePath = Object.keys(files).find((f) => f.startsWith('attachments/'))!
    const damaged = { ...files, [imagePath]: new Uint8Array([1, 2, 3]) }
    expect(await readArchive(zipSync(damaged))).toMatchObject({ ok: false, errors: [expect.stringMatching(/damaged/)] })

    const missing = { ...files }
    delete missing[imagePath]
    expect(await readArchive(zipSync(missing))).toMatchObject({ ok: false, errors: [expect.stringMatching(/missing from the archive/)] })
  })

  it('detects broken relationships and invalid rich text', async () => {
    const { records, blobs } = await validArchiveFiles()
    const orphan = { ...records, objects: records.objects.map((o) => ({ ...o, pageId: 'nope' })) }
    const r1 = await readArchive(await buildArchive(orphan, blobs, 'test'))
    expect(r1).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/missing page/)]) })

    const badSection = { ...records, sections: records.sections.map((s) => ({ ...s, notebookId: 'gone' })) }
    const r2 = await readArchive(await buildArchive(badSection, blobs, 'test'))
    expect(r2).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/missing notebook/)]) })

    const badDoc = {
      ...records,
      objects: records.objects.map((o) => (o.type === 'text' ? { ...o, doc: { type: 'doc', content: [{ type: 'script', text: 'alert(1)' }] } } : o)),
    }
    const r3 = await readArchive(await buildArchive(badDoc as typeof records, blobs, 'test'))
    expect(r3).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/not valid/)]) })

    const dup = { ...records, pages: [...records.pages, records.pages[0]] }
    const r4 = await readArchive(await buildArchive(dup, blobs, 'test'))
    expect(r4).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/Duplicate page/)]) })
  })

  it('ignores unexpected and unsafe archive entries with a warning', async () => {
    const { records, blobs } = await validArchiveFiles()
    const { unzipSync } = await import('fflate')
    const files = unzipSync(await buildArchive(records, blobs, 'test'))
    const result = await readArchive(zipSync({ ...files, '../evil.txt': strToU8('x'), 'extra.bin': strToU8('y') }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings.join(' ')).toMatch(/unsafe.*evil|evil.*unsafe|unexpected/)
  })
})

describe('backup folder snapshots (simulated directory handle)', () => {
  it('writes a verified snapshot and keeps only the newest 10', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    for (let i = 0; i < 12; i++) dir.files.set(snapshotFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))), new Uint8Array([i]))
    dir.files.set('notes.txt', new Uint8Array([1]))
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const result = await service.chooseFolder()
    expect(result).toMatchObject({ ok: true })
    const snapshots = [...dir.files.keys()].filter(isSnapshotName).sort()
    expect(snapshots).toHaveLength(10)
    expect(snapshots.at(-1)).toBe((result as { fileName: string }).fileName)
    // Unrelated files in the folder are never touched.
    expect(dir.files.has('notes.txt')).toBe(true)
    const restored = await readArchive(dir.files.get(snapshots.at(-1)!)!)
    expect(restored.ok).toBe(true)
    expect(service.getState().status.lastBackup?.fileName).toBe(snapshots.at(-1))
  })

  it('does not prune or report success when the write fails', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    for (let i = 0; i < 10; i++) dir.files.set(snapshotFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))), new Uint8Array([i]))
    const before = [...dir.files.keys()].sort()
    dir.failWrite = new DOMException('disk full', 'QuotaExceededError')
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const result = await service.chooseFolder()
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/disk is full/) })
    expect([...dir.files.keys()].sort()).toEqual(before)
    expect(service.getState().status.lastBackup).toBeNull()
    expect(service.getState().status.lastError?.message).toMatch(/disk is full/)
  })

  it('handles denied and revoked folder permission without losing data', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    dir.permission = 'prompt'
    dir.requestResult = 'denied'
    const { service, downloads } = serviceFor(src.store, dir)
    await service.init()
    expect(await service.chooseFolder()).toMatchObject({ ok: false })
    expect(service.getState().folderState).toBe('denied')

    // Later the user grants access; then the browser revokes it again.
    dir.requestResult = 'granted'
    expect(await service.reconnectFolder()).toMatchObject({ ok: true })
    expect(service.getState().folderState).toBe('granted')
    dir.permission = 'prompt'
    await service.refreshPermission()
    expect(service.getState().folderState).toBe('prompt')
    expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/Reconnect/) })
    // The downloadable fallback still works.
    expect(await service.downloadBackup()).toMatchObject({ ok: true })
    expect(downloads).toHaveLength(1)
    expect(Object.keys(src.store.getState().data.pages)).toHaveLength(2)
  })

  it('runs automatic snapshots only when changes exist and the interval has passed', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    const { service } = serviceFor(src.store, dir)
    await service.init()
    await service.chooseFolder()
    const count = () => [...dir.files.keys()].filter(isSnapshotName).length
    expect(count()).toBe(1)
    expect(service.isDue()).toBe(false)

    src.store.renamePage(src.page.id, 'Changed')
    await src.store.flush()
    const last = Date.parse(service.getState().status.lastBackup!.at)
    expect(service.isDue(last + 60_000)).toBe(false)
    expect(service.isDue(last + service.intervalMs + 1)).toBe(true)
    await service.tick(last + service.intervalMs + 1)
    expect(count()).toBe(2)

    // Read-only windows never write snapshots.
    src.store.renamePage(src.page.id, 'Changed again')
    await src.store.flush()
    src.store.setReadOnly(true)
    await service.tick(Date.now() + service.intervalMs * 2)
    expect(count()).toBe(2)
  })
})

describe('saved folder crash guard', () => {
  it('forgets the saved folder if reading it never finished in this tab', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    const first = serviceFor(src.store, dir)
    await first.service.init()
    await first.service.chooseFolder()
    expect(first.service.getState().folderName).toBe('Dropbox Backups')

    let marker = true // as if the previous read crashed the page
    const guarded = new BackupService(src.store, {
      appVersion: 'test',
      folderSupported: true,
      crashGuard: { isSet: () => marker, set: (on) => (marker = on) },
    })
    await guarded.init()
    expect(guarded.getState().folderState).toBe('none')
    expect(guarded.getState().status.lastError?.message).toMatch(/Choose the backup folder again/)
    expect(marker).toBe(false)

    // A normal start afterwards reads settings without the stale handle.
    const normal = new BackupService(src.store, { appVersion: 'test', folderSupported: true, crashGuard: { isSet: () => false, set: () => undefined } })
    await normal.init()
    expect(normal.getState().folderName).toBeNull()
  })
})

