import { strToU8, unzipSync, zipSync } from 'fflate'
import { buildArchive, sha256Hex } from '../backup/archive'
import type { WorkspaceRecords } from '../domain/types'

/** Records shaped exactly as data format 1 (Stage 1) stored them. */
export function toStage1Records(records: WorkspaceRecords): Record<string, unknown> {
  const strip = <T extends object>(list: T[], keys: string[]) =>
    list.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k))))
  return {
    workspace: { ...records.workspace, formatVersion: 1 },
    notebooks: strip(records.notebooks, ['categoryIds']),
    sections: strip(records.sections, ['categoryIds']),
    pages: strip(records.pages, ['categoryIds', 'tagIds', 'copiedFrom']),
    objects: records.objects,
    attachments: records.attachments,
  }
}

/** A complete format-1 backup archive, as app versions 0.1.0–0.1.2 wrote it. */
export async function buildStage1Archive(records: Record<string, unknown>, blobs: Map<string, Blob>): Promise<Uint8Array> {
  const empty = { projects: [], tasks: [], templates: [], categories: [], tags: [] }
  const modern = await buildArchive({ ...(records as unknown as WorkspaceRecords), ...empty }, blobs, '0.1.2')
  const files = unzipSync(modern)
  const recordsBytes = strToU8(JSON.stringify(records, null, 1))
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<string, unknown> & { counts: Record<string, number> }
  delete manifest.counts.projects
  delete manifest.counts.categories
  delete manifest.counts.tags
  delete manifest.counts.tasks
  delete manifest.counts.templates
  manifest.formatVersion = 1
  manifest.app = { name: 'Minty Notes', version: '0.1.2' }
  manifest.records = { path: 'records.json', size: recordsBytes.byteLength, sha256: await sha256Hex(recordsBytes) }
  files['records.json'] = recordsBytes
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(files)
}

/** Records shaped exactly as data format 2 (Stage 2, apps 0.2.0–0.2.1) stored them. */
export function toStage2Records(records: WorkspaceRecords): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...records, workspace: { ...records.workspace, formatVersion: 2 } }
  delete rest.tasks
  delete rest.templates
  rest.projects = records.projects.map((p) => ({ ...p, fileLocations: p.fileLocations.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'description'))) }))
  return rest
}

/** A complete format-2 backup archive, as app versions 0.2.0–0.2.1 wrote it. */
export async function buildStage2Archive(records: Record<string, unknown>, blobs: Map<string, Blob>): Promise<Uint8Array> {
  const modern = await buildArchive({ ...(records as unknown as WorkspaceRecords), tasks: [], templates: [] }, blobs, '0.2.1')
  const files = unzipSync(modern)
  const recordsBytes = strToU8(JSON.stringify(records, null, 1))
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<string, unknown> & { counts: Record<string, number> }
  delete manifest.counts.tasks
  delete manifest.counts.templates
  manifest.formatVersion = 2
  manifest.app = { name: 'Minty Notes', version: '0.2.1' }
  manifest.records = { path: 'records.json', size: recordsBytes.byteLength, sha256: await sha256Hex(recordsBytes) }
  files['records.json'] = recordsBytes
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(files)
}
