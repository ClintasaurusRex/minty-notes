import type { WorkspaceRecords } from '../domain/types'
import type { WorkspaceStore } from '../store/workspaceStore'
import { buildProjectPackage } from './buildPackage'
import { projectPackageFileName } from './format'
import { DEFAULT_IMPORT_OPTIONS, planProjectImport, verifyImportPlan, type ImportCounts, type ImportOptions, type ImportPlan } from './importPlan'
import { readProjectPackage, type ValidPackage } from './readPackage'
import { selectProject, type ExportOptions, type ExportSummary } from './selectProject'

/**
 * Portable project export and import, on top of the store and repository.
 * Export only reads. Import adds one new project through a single
 * all-or-nothing transaction and never replaces anything (it is not a restore).
 */

/** One consistent read of the saved workspace, used to preview and then build a package. */
export interface ExportSnapshot {
  records: WorkspaceRecords
  blobs: Map<string, Blob>
  revision: number
}

/**
 * Read the saved workspace for an export. In the editing window, pending edits
 * are saved first so the package is complete; a read-only window exports what
 * is saved. Nothing is changed.
 */
export async function loadExportSnapshot(store: WorkspaceStore): Promise<ExportSnapshot> {
  if (store.isOwner && !store.getState().readOnly) {
    const saved = await store.flush()
    if (!saved) throw new Error('Recent changes could not be saved, so an export now would be incomplete. Resolve the save error and try again.')
  }
  return store.repository.readAll()
}

export interface ExportResult {
  bytes: Uint8Array
  fileName: string
  summary: ExportSummary
}

/**
 * Build the package for one project from a snapshot, then read it back with
 * the same checks an import makes. A package that would not import is never
 * handed out.
 */
export async function buildProjectExport(snapshot: ExportSnapshot, projectId: string, options: ExportOptions, appVersion: string, now = new Date()): Promise<ExportResult> {
  const createdAt = now.toISOString()
  const selection = selectProject(snapshot.records, projectId, options, createdAt)
  const bytes = await buildProjectPackage(selection.records, snapshot.blobs, { workspaceId: snapshot.records.workspace.workspaceId, appVersion, createdAt })
  const check = await readProjectPackage(bytes)
  if (!check.ok) throw new Error(`The project could not be packaged in a form Minty Notes can import again, so nothing was exported: ${check.errors.slice(0, 3).join(' ')}`)
  return { bytes, fileName: projectPackageFileName(selection.summary.projectName, now), summary: selection.summary }
}

export interface ImportResult {
  projectId: string
  projectName: string
  counts: ImportCounts
  /** Old (package) ID → ID in this workspace, per record kind. */
  idMap: ImportPlan['idMap']
}

export interface ImportDeps {
  /** New record IDs (tests inject a predictable or colliding source). */
  makeId?: () => string
  /** Free browser storage in bytes, or null when unknown. */
  freeBytes?: () => Promise<number | null>
}

/**
 * Import a validated package as a new, independent project. The plan is built
 * against the workspace exactly as stored, verified, and written in one
 * transaction; if anything fails, the workspace is unchanged.
 */
export async function importProjectPackage(store: WorkspaceStore, pkg: ValidPackage, options: ImportOptions = DEFAULT_IMPORT_OPTIONS, deps: ImportDeps = {}): Promise<ImportResult> {
  if (store.getState().readOnly || !store.isOwner) throw new Error('Importing a project is only possible in the window that is editing. Use “Edit here instead” first.')
  const free = deps.freeBytes ? await deps.freeBytes().catch(() => null) : null
  if (free !== null && pkg.summary.attachmentBytes > free) {
    throw new Error('There is not enough free browser storage for the files in this package. Nothing was imported. Free up disk space and try again.')
  }
  let result: ImportResult | null = null
  await store.addImportedRecords((data) => {
    const plan = planProjectImport(pkg, data, options, deps.makeId)
    verifyImportPlan(plan, data)
    result = { projectId: plan.projectId, projectName: plan.projectName, counts: plan.counts, idMap: plan.idMap }
    return plan.batch
  })
  if (!result) throw new Error('The import did not run.')
  return result
}
