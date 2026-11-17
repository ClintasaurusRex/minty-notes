import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readArchive, sha256Hex } from '../backup/archive'
import { BackupService } from '../backup/backupService'
import { isSnapshotName, listSnapshots, pruneSnapshots, snapshotFileName, type LedgerEntry } from '../backup/folder'
import { pageLinkIds } from '../domain/pageLink'
import { FORMAT_VERSION, type Page, type TextObject, type WorkspaceRecords } from '../domain/types'
import { DOCX_PNG } from '../test/docFixtures'
import { PNG_1x1 } from '../test/fixtures'
import { addPrivateLinks, DELETED_PAGE_ID, destinationWorkspace, HIDDEN_PNG, OTHER_PROJECT_PNG, sourceWorkspace, SCREENSHOT_MARKUP, SKETCH_MARKUP } from '../test/portableFixtures'
import { PACKAGE_ATTACHMENT_PATH, PACKAGE_VERSION, projectPackageFileName, type PackageManifest, type PackageRecords } from './format'
import { buildProjectExport, importProjectPackage, loadExportSnapshot } from './projectTransfer'
import { readProjectPackage } from './readPackage'
import { DEFAULT_EXPORT_OPTIONS, selectProject } from './selectProject'

const NOW = new Date('2026-11-11T15:04:05.000Z')

async function blobHashes(blobs: Map<string, Blob>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [id, blob] of blobs) out[id] = await sha256Hex(new Uint8Array(await blob.arrayBuffer()))
  return out
}

function unpack(bytes: Uint8Array) {
  const files = unzipSync(bytes)
  return { files, manifest: JSON.parse(strFromU8(files['manifest.json'])) as PackageManifest, records: JSON.parse(strFromU8(files['project.json'])) as PackageRecords }
}

describe('what a project package contains', () => {
  it('includes the project, its live notes, tasks, and the pages it links to directly — and nothing else', async () => {
    const src = await sourceWorkspace()
    const snapshot = await loadExportSnapshot(src.store)
    const { records, summary } = selectProject(snapshot.records, src.project.id, DEFAULT_EXPORT_OPTIONS, NOW.toISOString())
    const titles = (pages: Page[]) => pages.map((p) => p.title)
    const referenceIds = new Set(records.references.map((r) => r.pageId))

    // Notes: live project pages in their order; the trashed draft is left out.
    expect(titles(records.pages.filter((p) => !referenceIds.has(p.id)))).toEqual(['LS7 control narrative', 'LS7 procedure', 'Commissioning notes', 'Tag naming'])
    expect(summary.trashedNotes).toBe(1)

    // References: library pages that are pinned, linked from a note, or linked from a task.
    // Not: suggested-only, hidden, depth-2, trashed — and never a page of another project, although a note links to one.
    expect(records.references.map((r) => [src.store.getState().data.pages[r.pageId].title, r.reasons, r.from])).toEqual([
      ['Alarm setup', ['pinned', 'link', 'task'], 'VTScada reference › General'],
      ['Tag naming', ['pinned'], 'VTScada reference › General'],
      ['Ladder tips', ['task'], 'Standalone notes'],
    ])
    expect(summary.references.some((r) => r.title === 'North station wiring check')).toBe(false)
    expect(summary.excluded).toEqual([{ pageId: src.otherProject.otherNote.id, title: 'North station wiring check', from: 'Project: North pump station', reasons: ['link'], why: 'other-project' }])
    expect(summary.references.find((r) => r.title === 'Alarm priorities (deep)')).toMatchObject({ included: false, group: 'suggested', groups: ['suggested'], reasons: ['suggested'] })
    expect(summary.references.find((r) => r.title === 'Alarm setup')).toMatchObject({ included: true, group: 'pinned', groups: ['pinned', 'linked'] })
    expect(summary.references.some((r) => r.title === 'Old driver hint')).toBe(false)
    expect(summary.hiddenReferences).toBe(1)

    // Every page in the package belongs to the one project; snapshots are independent copies.
    expect(records.pages.every((p) => p.location.kind === 'project' && p.location.projectId === src.project.id && p.trashedAt === null)).toBe(true)
    const alarm = records.pages.find((p) => p.id === src.library.alarm.id)!
    expect(alarm.copiedFrom).toEqual({ pageId: null, title: 'Alarm setup', at: NOW.toISOString() })
    expect(alarm.categoryIds).toEqual([src.categories.vt.id]) // inherited from its notebook, now its own
    // The project copy still points at its original, because the original comes along.
    expect(records.pages.find((p) => p.id === src.notes.copy.id)!.copiedFrom?.pageId).toBe(src.library.tagNaming.id)

    // Tasks keep status, order, priority, due date; links only to packaged pages.
    const task = (title: string) => records.tasks.find((t) => t.title === title)!
    expect(records.tasks).toHaveLength(4)
    expect(task('Check I/O list')).toMatchObject({ status: 'todo', priority: 'high', dueDate: '2026-11-20', order: 2, linkedPageIds: [src.notes.notes.id, src.library.ladder.id] })
    expect(task('Site acceptance test')).toMatchObject({ status: 'todo', order: 1, dueDate: '2026-12-10', priority: 'low' })
    expect(task('Configure alarms')).toMatchObject({ status: 'doing', priority: 'urgent', linkedPageIds: [src.library.alarm.id] }) // the trashed page is dropped
    expect(task('Order panel parts').status).toBe('done')
    expect(task('Order panel parts').completedAt).not.toBeNull()

    // Project: details and file locations as text; pins only for packaged snapshots; no hidden list.
    expect(records.project).toMatchObject({ name: 'Lift Station 7 upgrade', customer: 'City of Example', jobNumber: 'J-2207', dueDate: '2026-12-15', hiddenPageIds: [] })
    expect(records.project.pinnedPageIds.sort()).toEqual([src.library.alarm.id, src.library.tagNaming.id].sort())
    expect(records.project.fileLocations.map((f) => [f.kind, f.value, f.description])).toEqual([
      ['path', 'C:\\Jobs\\J-2207', 'Drawings and backups'],
      ['url', 'https://www.dropbox.com/home/J-2207', 'Shared with the customer'],
    ])
    expect(summary.fileLocations).toEqual({ paths: 1, links: 1 })

    // Categories and tags: only those in use by packaged records.
    expect(records.categories.map((c) => c.name)).toEqual(['VTScada', 'Panel building', 'Studio 5000'])
    expect(records.tags.map((t) => t.name)).toEqual(['commissioning', 'io-list'])

    // Attachments: both images and both originals — not the unrelated ones.
    expect(records.attachments.map((a) => a.fileName).sort()).toEqual(['HMI screenshot.png', 'LS7 control narrative.pdf', 'LS7 procedure.docx', 'alarm-dialog.png'])
    expect(summary).toMatchObject({ images: 2, originals: 2, sketches: 1, coveredImages: 1, tasks: { total: 4, done: 1 }, clearedDueDates: 0 })

    // Links that lead outside the package are counted by reason.
    expect(summary.unresolved).toEqual({ linksToTrash: 1, linksToDeleted: 1, linksToHidden: 0, linksToOtherProjects: 1, linksNotIncluded: 1, taskLinks: 1 })

    // Nothing of the unrelated project, inbox, or Trash is in the package.
    const json = JSON.stringify(records)
    for (const secret of ['CONFIDENTIAL-OTHER-PROJECT', 'UNRELATED-INBOX-TEXT', 'TRASHED-NOTE-TEXT', 'North station pricing', 'Order North station spares', 'Only for the legacy driver', 'Other Customer Ltd', '1 critical, 2 high', 'North station wiring check', 'Terminal strip X1 verified', 'North pump station']) expect(json).not.toContain(secret)
  })

  it('reference options are predictable: each group can be left out, and suggestions are opt-in', async () => {
    const src = await sourceWorkspace()
    const snapshot = await loadExportSnapshot(src.store)
    const titlesWith = (o: Partial<typeof DEFAULT_EXPORT_OPTIONS>) => {
      const s = selectProject(snapshot.records, src.project.id, { ...DEFAULT_EXPORT_OPTIONS, ...o }, NOW.toISOString())
      return { titles: s.summary.references.filter((r) => r.included).map((r) => r.title), s }
    }
    expect(titlesWith({ includeSuggested: true }).titles).toEqual(['Alarm setup', 'Tag naming', 'Ladder tips', 'Alarm priorities (deep)'])
    expect(titlesWith({ includeSuggested: true }).s.summary.unresolved.linksNotIncluded).toBe(0)
    // Without pinned pages: a pinned page that is also linked still comes with "linked".
    expect(titlesWith({ includePinned: false }).titles).toEqual(['Alarm setup', 'Ladder tips'])
    // Without any references, links are counted as left out, task links are dropped, and the copy forgets its original.
    const none = titlesWith({ includePinned: false, includeLinked: false }).s
    expect(none.records.references).toEqual([])
    expect(none.records.project.pinnedPageIds).toEqual([])
    expect(none.summary.unresolved).toEqual({ linksToTrash: 1, linksToDeleted: 1, linksToHidden: 0, linksToOtherProjects: 1, linksNotIncluded: 1, taskLinks: 3 })
    // No choice in the dialog can bring in another project's page.
    for (const o of [{ includeSuggested: true }, { includePinned: false }, { includeLinked: false }]) expect(titlesWith(o).s.summary.excluded.map((x) => x.title)).toEqual(['North station wiring check'])
    expect(none.records.pages.find((p) => p.id === src.notes.copy.id)!.copiedFrom).toMatchObject({ pageId: null, title: 'Tag naming' })
    expect(none.records.attachments.map((a) => a.fileName).sort()).toEqual(['HMI screenshot.png', 'LS7 control narrative.pdf', 'LS7 procedure.docx'])
  })

  it('refuses a missing project and repairs a due date that is not a real date', async () => {
    const src = await sourceWorkspace()
    const snapshot = await loadExportSnapshot(src.store)
    expect(() => selectProject(snapshot.records, 'nope', DEFAULT_EXPORT_OPTIONS, NOW.toISOString())).toThrow(/no longer exists/)
    // App 0.2.0 could store such a value; the package must still be importable.
    const records: WorkspaceRecords = structuredClone(snapshot.records)
    records.projects.find((p) => p.id === src.project.id)!.dueDate = '20261-12-15'
    const out = await buildProjectExport({ ...snapshot, records }, src.project.id, DEFAULT_EXPORT_OPTIONS, 'test', NOW)
    expect(out.summary.clearedDueDates).toBe(1)
    const read = await readProjectPackage(out.bytes)
    expect(read.ok && read.records.project.dueDate).toBeNull()
  })
})

describe('privacy: hidden pages and other projects never travel', () => {
  /** Text that exists only on pages that must not be packaged. */
  const SECRETS = [
    'HIDDEN-PAGE-SECRET-TEXT',
    'Customer passwords (hidden)',
    'hidden-wiring-photo.png',
    'HIDDEN-IMAGE-BYTES',
    'HIDDEN-PINNED-TEXT',
    'Old site contacts (was pinned)',
    'Only for the legacy driver',
    'Old driver hint',
    'CONFIDENTIAL-OTHER-PROJECT',
    'North station pricing',
    'pricing-sheet.png',
    'OTHER-PROJECT-IMAGE-BYTES',
    'North station wiring check',
    'Terminal strip X1 verified',
    'North pump station',
    'Other Customer Ltd',
  ]
  const latin1 = new TextDecoder('latin1')
  const ALL_ON = { includePinned: true, includeLinked: true, includeSuggested: true }

  it('whatever points at them and whatever is chosen, their text, titles, and files are not in the ZIP', async () => {
    const src = await sourceWorkspace()
    const extra = await addPrivateLinks(src)
    const snapshot = await loadExportSnapshot(src.store)
    const hiddenSha = await sha256Hex(HIDDEN_PNG)
    const otherSha = await sha256Hex(OTHER_PROJECT_PNG)
    // The workspace really holds these files (so their absence below means something).
    const stored = await Promise.all([...snapshot.blobs.values()].map(async (b) => sha256Hex(new Uint8Array(await b.arrayBuffer()))))
    expect(stored).toEqual(expect.arrayContaining([hiddenSha, otherSha]))

    for (const options of [DEFAULT_EXPORT_OPTIONS, ALL_ON, { includePinned: true, includeLinked: false, includeSuggested: false }, { includePinned: false, includeLinked: true, includeSuggested: true }]) {
      const out = await buildProjectExport(snapshot, src.project.id, options, 'test', NOW)
      const label = JSON.stringify(options)

      // ---- the actual payload: every file of the ZIP, unpacked, and the raw ZIP bytes (attachments are stored as they are)
      const files = unzipSync(out.bytes)
      for (const [name, data] of Object.entries(files)) {
        const content = latin1.decode(data)
        for (const secret of SECRETS) expect(content.includes(secret), `${secret} in ${name} with ${label}`).toBe(false)
        // Not even the IDs of the excluded files.
        for (const id of [extra.hiddenImage.attachmentId, extra.otherImage.attachmentId]) expect(content.includes(id), `${name} with ${label}`).toBe(false)
      }
      const raw = latin1.decode(out.bytes)
      for (const marker of ['HIDDEN-IMAGE-BYTES', 'OTHER-PROJECT-IMAGE-BYTES']) expect(raw.includes(marker), label).toBe(false)
      const attachmentFiles = Object.keys(files).filter((n) => n.startsWith('attachments/'))
      for (const name of attachmentFiles) expect([hiddenSha, otherSha]).not.toContain(await sha256Hex(files[name]))

      // ---- the records in the payload
      const records = JSON.parse(strFromU8(files['project.json'])) as PackageRecords
      const manifest = JSON.parse(strFromU8(files['manifest.json'])) as PackageManifest
      const excludedIds = [extra.hiddenLinked.id, extra.hiddenPinned.id, src.library.hidden.id, src.otherProject.otherSecret.id, src.otherProject.otherNote.id]
      for (const id of excludedIds) {
        expect(records.pages.some((p) => p.id === id), label).toBe(false)
        expect(records.references.some((r) => r.pageId === id), label).toBe(false)
        expect(records.project.pinnedPageIds, label).not.toContain(id)
        expect(records.objects.some((o) => o.pageId === id), label).toBe(false)
        for (const t of records.tasks) expect(t.linkedPageIds, label).not.toContain(id)
      }
      expect(records.project.hiddenPageIds).toEqual([])
      expect(records.references.every((r) => !r.from.startsWith('Project:'))).toBe(true)
      expect(records.tasks.find((t) => t.title === 'Ask for site access')!.linkedPageIds).toEqual([extra.access.id])
      // The links themselves stay in the text exactly as written: they are not removed and not pointed elsewhere.
      expect(pageLinkIds((records.objects.find((o) => o.id === extra.accessText.id) as TextObject).doc)).toEqual([extra.hiddenLinked.id, extra.hiddenPinned.id, src.otherProject.otherSecret.id, src.library.ladder.id])

      // ---- the summary shown before the download says what the payload holds
      const { summary } = out
      const included = summary.references.filter((r) => r.included)
      expect(included.map((r) => r.pageId).sort(), label).toEqual(records.references.map((r) => r.pageId).sort())
      expect(manifest.counts.references).toBe(included.length)
      expect(manifest.counts.notes).toBe(summary.notes.length)
      expect(manifest.counts.attachments).toBe(attachmentFiles.length)
      expect(summary.images + summary.originals).toBe(attachmentFiles.length)
      expect(summary.attachmentBytes).toBe(attachmentFiles.reduce((n, name) => n + files[name].byteLength, 0))
      expect(summary.references.some((r) => excludedIds.includes(r.pageId)), label).toBe(false)
      expect(summary.hiddenReferences).toBe(3)
      const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)
      expect([...summary.excluded].sort(byTitle), label).toEqual(
        [
          { pageId: extra.hiddenLinked.id, title: 'Customer passwords (hidden)', from: 'VTScada reference › General', reasons: ['link', 'task'], why: 'hidden' },
          { pageId: extra.hiddenPinned.id, title: 'Old site contacts (was pinned)', from: 'VTScada reference › General', reasons: ['link'], why: 'hidden' },
          { pageId: src.otherProject.otherSecret.id, title: 'North station pricing', from: 'Project: North pump station', reasons: ['pinned', 'link', 'task'], why: 'other-project' },
          { pageId: src.otherProject.otherNote.id, title: 'North station wiring check', from: 'Project: North pump station', reasons: ['link'], why: 'other-project' },
        ].sort(byTitle),
      )
      expect(summary.unresolved).toMatchObject({ linksToHidden: 2, linksToOtherProjects: 2 })

      // ---- and the package is a valid one
      const read = await readProjectPackage(out.bytes)
      if (!read.ok) throw new Error(read.errors.join('\n'))
      expect(read.summary.references.map((r) => r.pageId).sort()).toEqual(included.map((r) => r.pageId).sort())
    }
    // Eligible library pages are packaged as before.
    const all = selectProject(snapshot.records, src.project.id, ALL_ON, NOW.toISOString())
    expect(all.summary.references.filter((r) => r.included).map((r) => r.title)).toEqual(['Alarm setup', 'Tag naming', 'Ladder tips', 'Alarm priorities (deep)'])
  })

  it('a hidden page stays out even when the records say it is pinned as well', async () => {
    // The app cannot produce this (hiding removes the pin); a restored or damaged workspace could hold it.
    const src = await sourceWorkspace()
    const snapshot = await loadExportSnapshot(src.store)
    const records: WorkspaceRecords = structuredClone(snapshot.records)
    const project = records.projects.find((p) => p.id === src.project.id)!
    project.hiddenPageIds.push(src.library.alarm.id) // pinned, linked from a note, and linked from a task
    const out = await buildProjectExport({ ...snapshot, records }, src.project.id, { includePinned: true, includeLinked: true, includeSuggested: true }, 'test', NOW)
    const files = unzipSync(out.bytes)
    const packed = JSON.parse(strFromU8(files['project.json'])) as PackageRecords
    expect(packed.pages.some((p) => p.id === src.library.alarm.id || p.title === 'Alarm setup')).toBe(false)
    expect(packed.project.pinnedPageIds).not.toContain(src.library.alarm.id)
    expect(packed.attachments.map((a) => a.fileName)).not.toContain('alarm-dialog.png')
    expect(Object.keys(files).filter((n) => n.startsWith('attachments/'))).toHaveLength(3)
    expect(out.summary.excluded).toEqual([expect.objectContaining({ title: 'Alarm setup', why: 'hidden', reasons: ['pinned', 'link', 'task'] }), expect.objectContaining({ title: 'North station wiring check', why: 'other-project' })])
  })

  it('after import, links to the excluded pages are unavailable — never redirected, not even in the workspace that still has those pages', async () => {
    const src = await sourceWorkspace()
    const extra = await addPrivateLinks(src)
    const out = await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, ALL_ON, 'test', NOW)
    const pkg = await readProjectPackage(out.bytes)
    if (!pkg.ok) throw new Error(pkg.errors.join('\n'))
    const privateIds = [extra.hiddenLinked.id, extra.hiddenPinned.id, src.otherProject.otherSecret.id]

    // Another workspace: nothing of the excluded pages arrives.
    const dest = await destinationWorkspace()
    const there = await importProjectPackage(dest.store, pkg)
    const after = await dest.repo.readAll()
    const json = JSON.stringify(after.records)
    for (const secret of SECRETS) expect(json.includes(secret), secret).toBe(false)
    const hashes = await Promise.all([...after.blobs.values()].map(async (b) => sha256Hex(new Uint8Array(await b.arrayBuffer()))))
    expect(hashes).not.toContain(await sha256Hex(HIDDEN_PNG))
    expect(hashes).not.toContain(await sha256Hex(OTHER_PROJECT_PNG))
    const linksIn = (records: WorkspaceRecords, projectId: string) => {
      const note = records.pages.find((p) => p.title === 'Site access' && p.location.kind === 'project' && p.location.projectId === projectId)!
      return pageLinkIds((records.objects.find((o) => o.pageId === note.id) as TextObject).doc)
    }
    const [a, b, c, ladder] = linksIn(after.records, there.projectId)
    for (const id of [a, b, c]) {
      expect(after.records.pages.some((p) => p.id === id)).toBe(false) // unavailable
      expect(privateIds).not.toContain(id)
    }
    expect(after.records.pages.find((p) => p.id === ladder)).toMatchObject({ title: 'Ladder tips', location: { kind: 'project', projectId: there.projectId } })
    const task = after.records.tasks.find((t) => t.title === 'Ask for site access' && t.projectId === there.projectId)!
    expect(task.linkedPageIds).toEqual([after.records.pages.find((p) => p.title === 'Site access' && p.location.kind === 'project' && p.location.projectId === there.projectId)!.id])

    // The source workspace itself, with "link to my existing pages": the hidden and other-project pages
    // still exist there under the very IDs the links carried, and the links still do not lead to them.
    const back = await importProjectPackage(src.store, pkg, { reuseExisting: true })
    const again = await src.repo.readAll()
    const [a2, b2, c2, ladder2] = linksIn(again.records, back.projectId)
    for (const id of [a2, b2, c2]) {
      expect(privateIds).not.toContain(id)
      expect(again.records.pages.some((p) => p.id === id)).toBe(false)
    }
    expect(ladder2).toBe(src.library.ladder.id) // an eligible library page is linked again, as asked
    const imported = again.records.projects.find((p) => p.id === back.projectId)!
    for (const id of privateIds) expect(imported.pinnedPageIds).not.toContain(id)
    expect(imported.hiddenPageIds).toEqual([])
    expect(again.records.tasks.find((t) => t.title === 'Ask for site access' && t.projectId === back.projectId)!.linkedPageIds).toHaveLength(1)
  })
})

describe('exporting a project package', () => {
  it('writes a versioned, checksummed package and leaves the source workspace untouched', async () => {
    const src = await sourceWorkspace()
    const before = await src.repo.readAll()
    const beforeHashes = await blobHashes(before.blobs)

    const out = await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, DEFAULT_EXPORT_OPTIONS, '0.4.2', NOW)
    expect(out.fileName).toBe('minty-project-Lift-Station-7-upgrade-20261111-150405Z.zip')

    const { files, manifest, records } = unpack(out.bytes)
    const names = Object.keys(files).sort()
    expect(names.filter((n) => !n.startsWith('attachments/'))).toEqual(['README.txt', 'manifest.json', 'project.json'])
    expect(names.filter((n) => n.startsWith('attachments/')).every((n) => PACKAGE_ATTACHMENT_PATH.test(n))).toBe(true)
    expect(manifest).toMatchObject({
      format: 'minty-notes-project',
      packageVersion: PACKAGE_VERSION,
      formatVersion: FORMAT_VERSION,
      app: { name: 'Minty Notes', version: '0.4.2' },
      createdAt: NOW.toISOString(),
      sourceWorkspaceId: before.records.workspace.workspaceId,
      projectName: 'Lift Station 7 upgrade',
      counts: { notes: 4, references: 3, tasks: 4, attachments: 4, categories: 3, tags: 2 },
    })
    expect(manifest.records).toEqual({ path: 'project.json', size: files['project.json'].byteLength, sha256: await sha256Hex(files['project.json']) })

    // Attachment bytes are the stored originals, byte for byte — including the full image behind the redaction.
    const fileOf = (name: string) => files[manifest.files.find((f) => f.attachmentId === records.attachments.find((a) => a.fileName === name)!.id)!.path]
    expect(await sha256Hex(fileOf('HMI screenshot.png'))).toBe(await sha256Hex(PNG_1x1))
    expect(await sha256Hex(fileOf('alarm-dialog.png'))).toBe(await sha256Hex(DOCX_PNG))
    expect(await sha256Hex(fileOf('LS7 control narrative.pdf'))).toBe(await sha256Hex(src.files.pdf))
    expect(await sha256Hex(fileOf('LS7 procedure.docx'))).toBe(await sha256Hex(src.files.docx))
    for (const f of manifest.files) expect(await sha256Hex(files[f.path])).toBe(f.sha256)

    // Markup and sketch geometry are in the records as stored.
    expect(records.objects.find((o) => o.id === src.notes.screenshot.id)).toMatchObject({ type: 'image', markup: SCREENSHOT_MARKUP })
    expect(records.objects.find((o) => o.id === src.notes.sketch.id)).toMatchObject({ type: 'sketch', markup: SKETCH_MARKUP, x: 48, y: 520, w: 600, h: 300 })
    // Page links are still by the source's page IDs inside the package.
    expect(pageLinkIds((records.objects.find((o) => o.id === src.notes.links.id) as TextObject).doc)).toEqual([src.library.alarm.id, src.otherProject.otherNote.id, src.library.trashedTarget.id, DELETED_PAGE_ID])

    expect(strFromU8(files['README.txt'])).toMatch(/not a sanitized document[\s\S]*redaction box[\s\S]*not a workspace backup/)

    // The package passes the importer's own validation.
    const read = await readProjectPackage(out.bytes)
    if (!read.ok) throw new Error(read.errors.join('\n'))
    expect(read.summary).toMatchObject({ projectName: 'Lift Station 7 upgrade', appVersion: '0.4.2', packageVersion: 1, formatVersion: FORMAT_VERSION, tasks: { total: 4, done: 1 }, images: 2, originals: 2, sketches: 1, coveredImages: 1, unresolvedLinks: 4, notesWithUnresolvedLinks: 2 })
    expect(read.summary.notes).toEqual(['LS7 control narrative', 'LS7 procedure', 'Commissioning notes', 'Tag naming'])
    expect(read.summary.references.map((r) => r.title)).toEqual(['Alarm setup', 'Tag naming', 'Ladder tips'])

    // Source: every record, every attachment byte, and the revision are exactly as before.
    const after = await src.repo.readAll()
    expect(after.records).toEqual(before.records)
    expect(after.revision).toBe(before.revision)
    expect(await blobHashes(after.blobs)).toEqual(beforeHashes)
    expect(src.store.getState().save.status).toBe('saved')
  })

  it('exports from a read-only window (it only reads) and saves pending edits first in the editing window', async () => {
    const src = await sourceWorkspace()
    src.store.renamePage(src.notes.notes.id, 'Commissioning notes (rev B)')
    const out = await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, DEFAULT_EXPORT_OPTIONS, 'test', NOW)
    expect(unpack(out.bytes).records.pages.map((p) => p.title)).toContain('Commissioning notes (rev B)')

    src.store.revokeOwnership()
    expect(src.store.getState().readOnly).toBe(true)
    const again = await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, DEFAULT_EXPORT_OPTIONS, 'test', NOW)
    expect((await readProjectPackage(again.bytes)).ok).toBe(true)
  })

  it('refuses to export when a file the project uses is missing', async () => {
    const src = await sourceWorkspace()
    const snapshot = await loadExportSnapshot(src.store)
    const blobs = new Map(snapshot.blobs)
    blobs.delete(src.notes.screenshot.attachmentId)
    await expect(buildProjectExport({ ...snapshot, blobs }, src.project.id, DEFAULT_EXPORT_OPTIONS, 'test', NOW)).rejects.toThrow(/“HMI screenshot.png” is missing/)
  })
})

describe('packages and backups stay separate', () => {
  it('a package file name is never a backup snapshot name, and pruning never removes a package', async () => {
    const name = projectPackageFileName('Lift Station 7 upgrade', NOW)
    expect(isSnapshotName(name)).toBe(false)
    expect(projectPackageFileName('  ///  ', NOW)).toBe('minty-project-project-20261111-150405Z.zip')
    expect(projectPackageFileName('Größe & Maße: “Ünïcode” <test>', NOW)).toBe('minty-project-Größe-Maße-Ünïcode-test-20261111-150405Z.zip')

    // A backup folder with 12 recorded snapshots, a package, and another file: pruning keeps the newest 10 snapshots and both other files.
    const files = new Map<string, Uint8Array>()
    const ledger: LedgerEntry[] = []
    for (let i = 0; i < 12; i++) {
      const fileName = snapshotFileName(new Date(Date.UTC(2026, 10, 1, 10, i)))
      const bytes = new Uint8Array([i])
      files.set(fileName, bytes)
      ledger.push({ seq: i + 1, fileName, size: 1, sha256: await sha256Hex(bytes), at: '', revision: i })
    }
    // Even a ledger entry naming the package is ignored: retention only considers snapshot names.
    files.set(name, new Uint8Array([99]))
    ledger.unshift({ seq: 0, fileName: name, size: 1, sha256: await sha256Hex(new Uint8Array([99])), at: '', revision: 0 })
    files.set('holiday.jpg', new Uint8Array(1))
    const dir = {
      async *keys() {
        yield* [...files.keys()]
      },
      async removeEntry(n: string) {
        files.delete(n)
      },
      async getFileHandle(n: string) {
        if (!files.has(n)) throw new DOMException('missing', 'NotFoundError')
        return { getFile: async () => new Blob([files.get(n)! as Uint8Array<ArrayBuffer>]) }
      },
    } as unknown as FileSystemDirectoryHandle
    const report = await pruneSnapshots(dir, 10, ledger, ledger.at(-1)!.fileName)
    expect(report.removed).toEqual([ledger[1].fileName, ledger[2].fileName])
    expect(await listSnapshots(dir)).toHaveLength(10)
    expect(files.has(name) && files.has('holiday.jpg')).toBe(true)
  })

  it('a package is refused as a backup, and a backup is refused as a package, each with a pointer to the right place', async () => {
    const src = await sourceWorkspace()
    const pkg = await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, DEFAULT_EXPORT_OPTIONS, 'test', NOW)
    const asBackup = await readArchive(pkg.bytes)
    expect(asBackup.ok).toBe(false)
    if (!asBackup.ok) expect(asBackup.errors[0]).toMatch(/portable project package, not a full workspace backup.*Import project/)

    const backup = new BackupService(src.store, { appVersion: 'test', folderSupported: false })
    const { bytes } = await backup.createArchive()
    const asPackage = await readProjectPackage(bytes)
    expect(asPackage.ok).toBe(false)
    if (!asPackage.ok) expect(asPackage.errors[0]).toMatch(/full workspace backup, not a project package.*Settings/)
  })
})
