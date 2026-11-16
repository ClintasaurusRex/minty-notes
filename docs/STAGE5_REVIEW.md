# Stage 5 review handoff — v0.5.0

Stage 5 is committed on `feature/stage-5-polish` (based on `6930901`) as the authorized v0.5.0 checkpoint and pushed to GitHub. No pull request, merge, deployment or Stage 6 work was performed. The intentional untracked `AGENTS.md` is preserved and excluded from the commit. Sections below record each review stage as it happened; earlier “uncommitted” notes describe those points in time.

Implementation and owner QA: [PROGRESS.md](PROGRESS.md). Architecture and migrations: [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_FORMAT.md](DATA_FORMAT.md). Performance data and reproduction: [STAGE5_PERFORMANCE.md](STAGE5_PERFORMANCE.md). Final automated totals are recorded in PROGRESS.md.

Review attention: manual sort must preserve timestamps/default Last edited; old workspace/package migrations must remain atomic; shared references stay distinct; native folder access is read-only/session-only; ZIP worker failure must not write/prune a backup; known editor ownership loss must stop further folder work. Security limits and redaction rules remain unchanged.

Development checks initially exposed trace-directory collisions, phone/tablet overflow and focus defects, a desktop Escape handler that closed the list during a file-picker workflow, and one stale Stage 4 format expectation. These were corrected and verified by the final suites; they are not waived failures. An independently reproduced backup ownership race was also corrected with four deterministic regression tests. Full-disk/permissions/migrations are simulated where described in PROGRESS.md; real IndexedDB/worker/offline/download/rendering behavior ran in isolated Chromium.

## Audit remediation (November 14, 2026)

The independent Stage 5 audit (PASS WITH FOLLOW-UPS) was remediated in place; details and verification are in [PROGRESS.md](PROGRESS.md#stage-5-audit-remediation-november-14-2026), design notes in ARCHITECTURE.md and DATA_FORMAT.md.

- **M1** — the first switch to Manual keeps the visible Last edited order; later switches restore the established Manual order (optional `Project.manualOrderSet`, format 5, no version bump; carried by backups and project packages, validated as boolean). Timestamps unchanged.
- **L1** — backup status is stored only by the window that owns editing; the `backupNow` error path never records over the editor's status after a takeover.
- **L2** — `WorkspaceStore.confirmOwnership()` checks the stored `editorOwner` token (the commit fence) before the folder write, retention, each deletion and the status write; a mismatch revokes ownership like a refused commit.
- **L3** — main-thread ZIP fallback only before the worker reports `ready`; post-startup crashes reject without rebuilding. Browser tests prove the downloaded backup is the worker's own output (SHA-256).
- **L4** — phone overlay no longer overwrites the desktop collapse preference; keyboard-operable, described reorder grips; folder-browser focus retention; accurate permission/“Stop browsing this folder” wording.

Remediation results: `npm run check` PASS (365 tests, 26 files); Chromium **59/59** PASS (3.6 min, port 4292, isolated output); `git diff --check` PASS. New regression tests were confirmed to fail against the previous logic. During repeated runs, four existing ordering tests became intermittent because of same-millisecond fixture timestamps under M1; the fixture was made deterministic (30/30 repeated runs pass). No failures were waived. Residual: a takeover in the instant between an ownership check and the following single folder operation cannot be fenced (folder APIs are outside IndexedDB transactions).

## Backup-safety remediation and final verdict (November 15, 2026)

The owner-approved local-time backup names (`minty-notes-backup-YYYYMMDD-HHMM(-n).zip`; older UTC `…-HHMMSSZ` names still recognised) were audited by Codex (FAIL: H1, H2, M1–M3). Remediation: retention by a verified ledger (`backupLedger`: self-checked archive, read-back SHA-256, sequence number recorded under the owner fence; removal only with 10 later-recorded snapshots that re-verify), no deletion on failed writes, a cleanup warning instead of any hard cap, and a fix for the folder-browser focus defect. Details: [PROGRESS.md](PROGRESS.md#backup-safety-remediation-november-15-2026-after-the-independent-audit-returned-fail).

**Codex follow-up verdict: PASS WITH NONBLOCKING FOLLOW-UPS.** H1, H2, M2 and M3 resolved; M1 partially resolved and accepted as nonblocking for the documented one-folder-per-workspace usage (no exclusive create or remove-if-unchanged in the API, and no bound on how long the remaining windows last). Owner manual QA: 20/20 passes reported by the owner (manual, separate from automated tests, before this remediation). Remaining limitations and recommended future regression tests: [PROGRESS.md](PROGRESS.md#stage-5-release-checkpoint-november-15-2026).

## Regression hardening (November 14, 2026)

Details: [PROGRESS.md](PROGRESS.md#stage-5-regression-hardening-november-14-2026). Codex began the pass and was stopped before reporting; its test changes were inspected, kept and completed, not redone.

- **Note ordering:** the conflicting-reorder test now asserts the exact merged orders and sequence (no sorting before comparison) through reload, backup/restore and project import. Covered: move into a Manual project (unit and browser), Trash restore (unit and browser, including the renumbered-siblings tie), drop on the end target (unit and browser). Field-wise held-edit merging can leave equal orders; they are deterministic and the next move renumbers 1…n (now tested). Not a defect; documented in ARCHITECTURE.md.
- **DB 5 → 6 with an older tab open:** synthetic DB 5 tab, blocking-then-closed and cooperating, in real Chromium. Every record and attachment hash is preserved, DB 6 / format 5, and a later DB 5 open gets `VersionError`. Also run against the actual 0.4.2 build in a temporary harness outside the repo. **Confirmed low-severity defect fixed:** a blocked upgrade showed “Opening Minty Notes…” indefinitely. It now shows a status message (close or reload the other Minty Notes windows; nothing has been changed yet) via `OpenOptions.onUpgradeBlocked`. No storage or format change.
- **Backup safety:** failed write/close/size verification keep existing snapshots byte-for-byte and the last-success status, and record a truthful error. A verified retry prunes to 10. Takeover during the write is tested with and without the lock-loss signal. A same-second name collision never overwrites or removes the existing snapshot, and an undeletable old snapshot still yields a truthful success. No defect found.
- **Results:** `npm run check` PASS (376 tests, 26 files); Chromium **63/63** PASS (3.8 min, port 4313, scratch output); `git diff --check` PASS. Mutation checks: the blocked-upgrade test failed without the hook; the collision test failed with name reuse forced.
- **Review attention:** `src/main.tsx` renders the waiting message before services exist; `src/app/services.ts`/`src/storage/db.ts` only pass the callback through. Residual: retention sorts by file-name timestamp (clock set back → newer snapshots pruned first; the new one is always protected); the takeover window between an ownership check and one folder call is unchanged.

## Documentation corrections (November 15, 2026)

Documentation only; no code, test or dependency change. Fixed the blank line that split the IndexedDB versions table in DATA_FORMAT.md. Documented that every workspace/device needs its own backup folder, with the then-current cross-workspace pruning and file-name collision risks (DATA_FORMAT.md, “Backup archive”; cross-workspace pruning no longer occurs since the ledger retention of November 15). Recorded two nonblocking known limitations in PROGRESS.md: shared backup folders, and a backup takeover message that can name a takeover when the ownership re-check failed for another reason (read-only window, unreadable owner token); nothing further is written, pruned or recorded in that case.

## Changed and new files

- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- [docs/CLAUDE_CODE_HANDOFF.md](../docs/CLAUDE_CODE_HANDOFF.md)
- [docs/DATA_FORMAT.md](../docs/DATA_FORMAT.md)
- [docs/MINTY_NOTES_PLAN.md](../docs/MINTY_NOTES_PLAN.md)
- [docs/PROGRESS.md](../docs/PROGRESS.md)
- [docs/STAGE5_PERFORMANCE.md](../docs/STAGE5_PERFORMANCE.md)
- [docs/STAGE5_REVIEW.md](../docs/STAGE5_REVIEW.md)
- [docs/performance/stage5-before-worker.json](../docs/performance/stage5-before-worker.json)
- [docs/performance/stage5-worker.json](../docs/performance/stage5-worker.json)
- [e2e/folderBrowser.spec.ts](../e2e/folderBrowser.spec.ts)
- [e2e/migration.spec.ts](../e2e/migration.spec.ts)
- [e2e/noteOrder.spec.ts](../e2e/noteOrder.spec.ts)
- [e2e/pdfExport.spec.ts](../e2e/pdfExport.spec.ts)
- [e2e/persistence.spec.ts](../e2e/persistence.spec.ts)
- [e2e/polish.spec.ts](../e2e/polish.spec.ts)
- [e2e/projectTransfer.spec.ts](../e2e/projectTransfer.spec.ts)
- [e2e/projects.spec.ts](../e2e/projects.spec.ts)
- [e2e/stage4.spec.ts](../e2e/stage4.spec.ts)
- [e2e/tasks.spec.ts](../e2e/tasks.spec.ts)
- [e2e/update.spec.ts](../e2e/update.spec.ts)
- [e2e/workflow.spec.ts](../e2e/workflow.spec.ts)
- [e2e/zipWorker.spec.ts](../e2e/zipWorker.spec.ts)
- [package-lock.json](../package-lock.json)
- [package.json](../package.json)
- [scripts/stage5-performance.mjs](../scripts/stage5-performance.mjs)
- [src/app/services.ts](../src/app/services.ts)
- [src/backup/archive.ts](../src/backup/archive.ts)
- [src/backup/archiveCompat.test.ts](../src/backup/archiveCompat.test.ts)
- [src/backup/archiveZip.test.ts](../src/backup/archiveZip.test.ts)
- [src/backup/archiveZip.ts](../src/backup/archiveZip.ts)
- [src/backup/archiveZipWorker.ts](../src/backup/archiveZipWorker.ts)
- [src/backup/backup.test.ts](../src/backup/backup.test.ts)
- [src/backup/backupService.ts](../src/backup/backupService.ts)
- [src/backup/folder.ts](../src/backup/folder.ts)
- [src/backup/retention.test.ts](../src/backup/retention.test.ts)
- [src/backup/snapshotNames.test.ts](../src/backup/snapshotNames.test.ts)
- [src/domain/references.ts](../src/domain/references.ts)
- [src/domain/types.ts](../src/domain/types.ts)
- [src/import/import.test.ts](../src/import/import.test.ts)
- [src/main.tsx](../src/main.tsx)
- [src/platform/folderBrowser.test.ts](../src/platform/folderBrowser.test.ts)
- [src/platform/folderBrowser.ts](../src/platform/folderBrowser.ts)
- [src/portable/cleanRecords.ts](../src/portable/cleanRecords.ts)
- [src/portable/packageValidation.test.ts](../src/portable/packageValidation.test.ts)
- [src/portable/projectExport.test.ts](../src/portable/projectExport.test.ts)
- [src/portable/readPackage.ts](../src/portable/readPackage.ts)
- [src/storage/db.test.ts](../src/storage/db.test.ts)
- [src/storage/db.ts](../src/storage/db.ts)
- [src/storage/repository.ts](../src/storage/repository.ts)
- [src/store/noteOrder.test.ts](../src/store/noteOrder.test.ts)
- [src/store/projects.test.ts](../src/store/projects.test.ts)
- [src/store/reconcile.ts](../src/store/reconcile.ts)
- [src/store/tasks.test.ts](../src/store/tasks.test.ts)
- [src/store/workspaceStore.ts](../src/store/workspaceStore.ts)
- [src/ui/App.tsx](../src/ui/App.tsx)
- [src/ui/FilesTab.tsx](../src/ui/FilesTab.tsx)
- [src/ui/FolderBrowser.tsx](../src/ui/FolderBrowser.tsx)
- [src/ui/HomeView.tsx](../src/ui/HomeView.tsx)
- [src/ui/KeyboardHelp.tsx](../src/ui/KeyboardHelp.tsx)
- [src/ui/NavigationPanel.tsx](../src/ui/NavigationPanel.tsx)
- [src/ui/Navigator.tsx](../src/ui/Navigator.tsx)
- [src/ui/ProjectView.tsx](../src/ui/ProjectView.tsx)
- [src/ui/SettingsView.tsx](../src/ui/SettingsView.tsx)
- [src/ui/app.css](../src/ui/app.css)
- [src/ui/canvas/PageView.tsx](../src/ui/canvas/PageView.tsx)
- [src/ui/folderBrowser.css](../src/ui/folderBrowser.css)
- [src/ui/noteOrder.css](../src/ui/noteOrder.css)

## Final validation and stopping point

- Baseline: build/lint, 319 unit tests, 44 Chromium tests passed at untouched HEAD.
- Final: build/lint, 343 unit tests in 26 files, 54/54 Chromium tests (3.5 minutes), and git diff --check passed. Final browser command used port 4280 and isolated production output/results; no additional full run is needed.
- No final automated failures remain. The preceding browser run had 53 passes and one stale expectation: Stage 4 expected “format 4” while the restore review correctly reported “format 5”. The final run passed with the corrected expectation. The earlier PDF-import Escape and phone overflow failures were confirmed UI defects and fixed; none was waived.
- Remaining platform/owner QA is listed in PROGRESS.md: native folder dialogs/permissions, actual touch/screen readers, installed app, Windows PDF readers/printing, real legacy database upgrades in a spare profile, and real work-laptop performance. Archive memory and remaining measured UI pauses are in STAGE5_PERFORMANCE.md.
- After regression hardening: build/lint, 376 unit tests in 26 files, 63/63 Chromium tests (3.8 minutes, port 4313, isolated output), and git diff --check passed.
- Git (at the November 14 checkpoint): feature/stage-5-polish; HEAD 6930901218421f0b2cad521e558848c26f2a1ec7; 39 modified tracked files + 22 new Stage 5 files; intentional AGENTS.md untracked.
- Release checkpoint (November 15, 2026): 43 modified tracked files + 24 new Stage 5 files (67 listed above) committed together as `feat: complete Minty Notes v0.5.0 Stage 5` and pushed to `feature/stage-5-polish`. AGENTS.md remains untracked and uncommitted. No pull request, merge, deployment or Stage 6.
