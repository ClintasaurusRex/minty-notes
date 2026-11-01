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
  const empty = { projects: [], categories: [], tags: [] }
  const modern = await buildArchive({ ...(records as unknown as WorkspaceRecords), ...empty }, blobs, '0.1.2')
  const files = unzipSync(modern)
  const recordsBytes = strToU8(JSON.stringify(records, null, 1))
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<string, unknown> & { counts: Record<string, number> }
  delete manifest.counts.projects
  delete manifest.counts.categories
  delete manifest.counts.tags
  manifest.formatVersion = 1
  manifest.app = { name: 'Minty Notes', version: '0.1.2' }
  manifest.records = { path: 'records.json', size: recordsBytes.byteLength, sha256: await sha256Hex(recordsBytes) }
  files['records.json'] = recordsBytes
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(files)
}
