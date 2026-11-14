import { describe, expect, it } from 'vitest'
import { docToPlainText } from '../domain/richtext'
import type { TextObject } from '../domain/types'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { readTestFile } from '../test/testFiles'
import { readArchive, sha256Hex } from './archive'
import { BackupService } from './backupService'

/**
 * Genuine backups keep restoring: one written by each release's own code
 * (0.1.0 → 0.4.1), and one unpacked and zipped again by common ZIP tools.
 * The files and how they were made: src/test/files/README.md.
 */

const file = (name: string) => readTestFile(new URL(`../test/files/backups/${name}`, import.meta.url))

const RELEASES: [version: string, format: number][] = [
  ['0.1.0', 1],
  ['0.1.1', 1],
  ['0.1.2', 1],
  ['0.2.0', 2],
  ['0.2.1', 2],
  ['0.3.0', 3],
  ['0.4.0', 4],
  ['0.4.1', 4],
]

const REPACKED = ['repacked-infozip-folders-comment.zip', 'repacked-infozip-descriptors.zip', 'repacked-infozip-zip64.zip', 'repacked-7zip.zip', 'repacked-python-stream-zip64.zip']

async function restoreInto(validated: Extract<Awaited<ReturnType<typeof readArchive>>, { ok: true }>) {
  const { store } = await freshStore()
  const service = new BackupService(store, { appVersion: 'test', folderSupported: false })
  await service.init()
  await service.restore(validated)
  return { store, service }
}

describe('a backup written by every earlier release restores completely', () => {
  it.each(RELEASES)('Minty Notes %s (data format %i)', async (version, format) => {
    const validated = await readArchive(file(`minty-${version}-backup.zip`))
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.summary).toMatchObject({ appVersion: version, formatVersion: format })
    expect(validated.warnings).toEqual([])

    const { store, service } = await restoreInto(validated)
    const data = store.getState().data
    const pages = Object.values(data.pages)
    expect(pages.map((p) => p.title).sort()).toEqual(format >= 2 ? ['Panel notes', 'Rack layout', 'VFD fault codes'] : ['Rack layout', 'VFD fault codes'])
    const note = pages.find((p) => p.title === 'VFD fault codes')!
    const objects = Object.values(await store.ensurePageObjects(note.id))
    const text = objects.find((o): o is TextObject => o.type === 'text')!
    expect(docToPlainText(text.doc)).toBe('Remember the VFD fault code F0071')
    const image = objects.find((o) => o.type === 'image')!
    expect(image).toMatchObject({ x: 520, y: 160, w: 300, h: 200 })
    const blob = await store.getBlob((image as { attachmentId: string }).attachmentId)
    expect(await sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(await sha256Hex(PNG_1x1))
    if (format >= 2) {
      expect(Object.values(data.projects).map((p) => p.name)).toEqual(['Lift Station 7'])
      expect(Object.values(data.categories).map((c) => c.name)).toEqual(['VTScada'])
      const tags = Object.values(data.tags)
      expect(tags.map((t) => t.name)).toEqual(['commissioning'])
      expect(note.tagIds).toEqual([tags[0].id])
    }
    if (format >= 3) expect(Object.values(data.tasks).map((t) => t.title)).toEqual(['Check the alarm list'])
    expect(data.workspace?.formatVersion).toBe(4)

    // …and the restored workspace backs up and restores again with this version.
    const again = await readArchive((await service.createArchive()).bytes)
    if (!again.ok) throw new Error(again.errors.join('\n'))
    expect(again.summary.counts).toEqual(validated.summary.counts)
  })
})

describe('a backup that was unpacked and zipped again by a ZIP tool still restores', () => {
  it.each(REPACKED)('%s', async (name) => {
    const original = await readArchive(file('minty-0.4.1-backup.zip'))
    const repacked = await readArchive(file(name))
    if (!original.ok || !repacked.ok) throw new Error([...(original.ok ? [] : original.errors), ...(repacked.ok ? [] : repacked.errors)].join('\n'))
    expect(repacked.records).toEqual(original.records)
    expect(repacked.warnings).toEqual([])
    for (const [id, blob] of original.blobs) {
      expect(await sha256Hex(new Uint8Array(await repacked.blobs.get(id)!.arrayBuffer())), id).toBe(await sha256Hex(new Uint8Array(await blob.arrayBuffer())))
    }
    const { store } = await restoreInto(repacked)
    expect(Object.values(store.getState().data.pages).map((p) => p.title).sort()).toEqual(['Panel notes', 'Rack layout', 'VFD fault codes'])
  })
})
