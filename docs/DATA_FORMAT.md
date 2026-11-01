# Minty Notes — data format (version 1)

`FORMAT_VERSION = 1` (`src/domain/types.ts`) versions the record shapes and backups. IndexedDB has its own schema version (`DB_VERSION = 2`, `src/storage/db.ts`). Any change to either needs a migration and a test.

## IDs and timestamps

- Every record has a stable ID (`crypto.randomUUID()`). IDs never change when a page is renamed or moved. Links always use IDs.
- Timestamps are ISO-8601 UTC strings (`2026-11-01T19:30:00.000Z`).

## Records

```ts
WorkspaceInfo { workspaceId, formatVersion, createdAt }

Notebook { id, title, order, createdAt, updatedAt }
Section  { id, notebookId, title, order, createdAt, updatedAt }

Page {
  id, title, order, width /* 1200 */, createdAt, updatedAt,
  location: { kind: 'inbox' } | { kind: 'standalone' } | { kind: 'section', sectionId },
  trashedAt: string | null
}

CanvasObject = TextObject | ImageObject   // shared: id, pageId, x, y, w, h, z, createdAt, updatedAt
TextObject  { type: 'text',  doc: ProseMirror JSON (TipTap schema) }   // h = measured height
ImageObject { type: 'image', attachmentId, alt }                     // h = displayed height

AttachmentMeta { id, fileName, mimeType, size, sha256, width, height, source: 'paste'|'file'|'drop', createdAt }
```

- Geometry is in page CSS pixels: `x ≥ 0`, `y ≥ 0`, `x + w ≤ page.width`. `z` orders overlaps (higher on top).
- Rich text uses the schema built from `richTextExtensions` (`src/domain/richtext.ts`): paragraph, heading 1–3, bullet/ordered list, blockquote, code block, horizontal rule, hard break; marks bold, italic, underline, strike, code, link (`http`, `https`, `mailto` only).
- A page never needs a project. Stage 2 will add `{ kind: 'project', projectId }` to `location`.
- Deleting a section/notebook is only allowed when it has no live pages. Its trashed pages are moved to `{ kind: 'inbox' }` (still trashed) at that moment, so no page ever points at a missing section; restoring them puts them in the Inbox.

## IndexedDB layout (`minty-notes`)

| Store | Key | Contents |
|---|---|---|
| `notebooks`, `sections`, `pages` | `id` | records above (`sections.byNotebook` index) |
| `objects` | `id` | canvas objects (`byPage` index) |
| `attachments` | `id` | attachment metadata |
| `blobs` | attachment id | image bytes (`Blob`) |
| `settings` | string key | see below |

Settings keys: `workspace` (WorkspaceInfo — **backed up**), and device-local values that are **not** backed up:

| Key | Contents |
|---|---|
| `activity` | `{ lastChangeAt, revision }` — `revision` increases by 1 in the same transaction as every committed change and every restore |
| `editorOwner` | `{ token, at }` — fencing token of the window allowed to write; commits and restores carrying another token are refused (`OwnershipError`) |
| `backupStatus` | `{ lastBackup: { at, fileName, revision }, lastDownloadAt, lastError }` — `revision` is the stored revision the snapshot captured (read in the same transaction as the archived records) |
| `backupFolder` | directory handle — never portable |
| `safeguard` | pre-restore ZIP |
| `ui` | reserved |

UI conveniences (last page, last list) are in `localStorage` (`minty:*`).

### IndexedDB versions

| `DB_VERSION` | App | Change |
|---|---|---|
| 1 | 0.1.0 | Initial stores. |
| 2 | 0.1.1 | No new stores. Migration (one upgrade transaction, aborted as a whole on error): add `activity.revision` (1 if `lastChangeAt` was set, else 0); move any page whose section no longer exists to `{ kind: 'inbox' }` (the trashed-page orphan left by 0.1.0). Status saved by 0.1.0 has no `lastBackup.revision`; it is treated as “not known to be backed up”, so one extra snapshot is written. |

## Backup archive

File name: `minty-notes-backup-YYYYMMDD-HHMMSSZ.zip` (UTC; `-2`, `-3`… if taken). Safety copies: `minty-notes-before-restore-…zip`.

```
manifest.json
records.json                 { workspace, notebooks, sections, pages, objects, attachments }
attachments/<id>.<ext>       original bytes (stored, not recompressed)
README.txt
```

`manifest.json`:

```json
{
  "format": "minty-notes-backup",
  "formatVersion": 1,
  "app": { "name": "Minty Notes", "version": "0.1.0" },
  "createdAt": "…",
  "workspaceId": "…",
  "counts": { "notebooks": 0, "sections": 0, "pages": 0, "objects": 0, "attachments": 0 },
  "records": { "path": "records.json", "size": 0, "sha256": "…" },
  "files": [{ "attachmentId": "…", "path": "attachments/….png", "size": 0, "sha256": "…", "mimeType": "image/png" }]
}
```

Before validation, version-1 archives get one known repair: a **trashed** page whose section is missing (written by app 0.1.0 after deleting that section or notebook) gets location `{ kind: 'inbox' }`, with a warning in the restore review. A live page pointing at a missing section is still rejected.

Restore rejects the archive (and changes nothing) if any of these fail: ZIP readable; total ≤ 4 GiB and ≤ 200,000 entries; format name; `1 ≤ formatVersion ≤ FORMAT_VERSION`; `records.json` checksum; record shapes and timestamps; unique IDs; section → notebook, page → section, object → page, image → attachment links; rich text valid for the schema; every attachment present with matching size and SHA-256. Unsafe paths (`..`, absolute, `\`) and unknown files are ignored with a warning.

A full backup is a complete working copy. It is not a redacted or share-safe export.

## Migrations

- Older archive versions will be migrated in `readArchive` before validation; newer ones are refused with "update the app".
- IndexedDB upgrades go in `openMintyDB`'s `upgrade` callback, keyed on `oldVersion`. Another open window is told to reload (`blocking`).
