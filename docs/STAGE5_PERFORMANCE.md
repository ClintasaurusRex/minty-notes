# Stage 5 engineering measurements

Measured November 14, 2026 using the production build and isolated Playwright Chromium contexts at `http://localhost:4375/`. No real browser profile, workspace, backup, or customer file was opened. This is a synthetic engineering observation, not a capacity guarantee or a work-laptop benchmark. Each table entry is one run; concurrent repository checks, OS caches, browser garbage collection, and automation overhead affect it. No CPU throttling was used.

Machine reported Intel Core i7-14700HX, 28 logical CPUs, 31.1 GiB RAM, Linux, Node v24.18.0, Chromium 153.0.8010.12 (installed Playwright build 1243). The app's existing safety limits were unchanged.

## Dataset and verification

- 50 active projects, exactly 1,000 notes and 1,000 tasks, 1,109 canvas objects.
- 25 imported image attachments totalling **270,801,670 bytes (258.3 MiB)**: ten genuine uncompressed 3,000×3,000 24-bit BMP files with synthetic random pixels, plus fifteen rendered 1,200×800 PNG screenshots. This exercises large original assets rather than ZIP padding. BMP is intentionally less compressed than typical screenshots/photos.
- One demanding page has exactly 100 objects: 85 live rich-text editors and 15 images. All ten large BMPs are on other pages of its project. Opening this page does not decode the whole workspace's images.
- One large DOCX: 27,007,777 bytes (25.8 MiB), 2,000 paragraphs, one 3,000×3,000 BMP. It imports as **50 editable text boxes and one image**, with the original kept.
- Full backup download: 270,853,592 bytes. Restored through the actual UI into a second clean context. Every stored record table was hashed in ID order, and every attachment was SHA-256 hashed: **all records and every byte matched**, including the edited demanding page.
- Project package: 270,814,491 bytes, 20 notes, 20 tasks, all 25 images. Built and checked by the production exporter, then validated/imported through the UI into a third clean context. Counts and every imported attachment SHA-256 matched. The existing portability tests separately cover remapped relationships, independent copies, references, malicious archives, and rollback.
- No unhandled browser errors occurred. Archive/ZIP size limits and validation were retained.

## Observed timings

The final column is the longest observed gap in a 25 ms browser timer while the operation ran, including timer scheduling and automation. It is a responsiveness indicator, **not** an exact animation-frame measurement. A zero means the operation finished before a probe tick. Times include the browser interaction and waiting for the stated visible outcome.

| Operation | After worker fix | Longest timer gap |
|---|---:|---:|
| Empty startup, navigation controls available | 144 ms | 66 ms |
| Populated workspace reload, index loaded and Saved | 165 ms | 36 ms |
| Projects → selected project overview | 100 ms | 53 ms |
| Search opening, text preparation and first result | 226 ms | 25 ms |
| Second query with search data ready | 10 ms | <25 ms |
| Demanding page, all 100 objects mounted and images loaded | 343 ms | 298 ms |
| Type 20 characters | 93 ms (4.6 ms/character) | 49 ms |
| Drag 40 pointer moves | 667 ms (16.7 ms/move) | 27 ms |
| Complete workspace backup, browser download saved | 2,156 ms | 278 ms |
| Clean restore, validation | 538 ms | — |
| Clean restore, safety copy + atomic replacement | 215 ms | — |
| Entire clean restore interaction | 818 ms | 466 ms |
| Project export preview | 40 ms | 25 ms |
| Project package construction, self-validation and download | 2,572 ms | 505 ms |
| Project package import validation | 512 ms | 376 ms |
| Project package atomic import | 99 ms | 28 ms |
| Large DOCX conversion, layout, image decode and save | 1,078 ms | 165 ms |

First restore of the generated fixture took 854 ms, including 546 ms validation and 237 ms replacement. This was a fresh synthetic workspace, so it did not measure safeguarding another 250 MB workspace during replacement. The subsequent backup/restore comparison used a clean destination too. Safeguarding an existing large destination requires additional time and memory.

## Measured bottleneck and narrow fix

The first run found **641 ms** and **1,189 ms** timer gaps while constructing the backup and project package. Inspection of the installed `fflate` writer (`node_modules/fflate/esm/browser.js`, `zip`, its per-file loop and final `cbf`) explained the pauses: although compression may be asynchronous, it computes every file's CRC and copies the complete ZIP on the calling thread. Images and document originals use level 0, so the large attachments still blocked that thread.

`src/backup/archiveZip.ts` now runs the same writer in a module worker (`archiveZipWorker.ts`) and transfers the completed ZIP back. It clones inputs so blocked-worker fallback cannot detach the caller's bytes. There is no format change and no validation bypass. A worker startup error uses the original writer; a writer error or five-minute timeout rejects the operation without writing/pruning a backup. All reader/security checks remain in place. The service worker precaches the new worker chunk, and `e2e/zipWorker.spec.ts` observes an actual archive worker successfully creating a complete backup while offline.

| Construction | Before worker: elapsed / max gap | After worker: elapsed / max gap |
|---|---:|---:|
| Backup | 1,876 / 641 ms | 2,156 / 278 ms |
| Project package + checking | 2,226 / 1,189 ms | 2,572 / 505 ms |

The change improves responsiveness at a modest total-time cost from worker startup and cloning. It does **not** make large archives streaming or eliminate every pause: structured cloning, file reads, JSON/record validation, image layout, and project self-validation still run partly on the page thread. The observed 376–466 ms validation gaps and 298 ms heavy-page mount are recorded as remaining limits. They do not justify a broad storage/editor rewrite in this milestone. A follow-up could move validated archive reading into a worker and stream ZIP creation to a user-selected destination, retaining the current safety boundaries.

## Memory observations

The script samples CDP `Runtime.getHeapUsage` after each operation; these are **not peak memory measurements** and omit worker memory, decoded image memory, GPU allocations, IndexedDB internals, and other browser processes. Garbage collection was not forced.

- Page JavaScript heap after startup: 6.5 MiB; after heavy-page open: 17.7 MiB; after dragging: 30.7 MiB.
- Browser backing storage reported after backup: 519 MiB; after package construction/checking: 523 MiB. The 258 MiB input and output can coexist. A discarded restore buffer remained until a later GC, demonstrating that immediate samples can include unreachable data.
- After large DOCX import: page heap 24.0 MiB, backing storage 78.8 MiB.
- Harness RSS was about 505–507 MiB while holding generated fixture bytes. This is the Node fixture/automation process, **not the application's browser RAM use**.

Several copies of a large archive can coexist across page, worker, and browser storage. The supported archive limits are security ceilings, not promises that a low-memory phone or laptop can process a file near them. Quota failures and atomic rollback remain covered by the existing simulated failure tests.

## Reproduction and remaining owner QA

Use a separate production output directory and port, keeping any everyday app server untouched:

```sh
npm run build -- --outDir /tmp/minty-stage5-perf-dist
npm run preview -- --port 4375 --strictPort --outDir /tmp/minty-stage5-perf-dist
# In a second terminal:
node scripts/stage5-performance.mjs http://localhost:4375/
```

The script writes generated fixtures, downloads, screenshot and `results.json` to a fresh `/tmp/minty-stage5-performance-*` directory. It needs roughly 1.1 GiB of temporary disk space. `MINTY_PERF_LARGE_IMAGES=0` runs a smaller smoke check, which must not be reported as the full dataset benchmark. Metadata from the two measured full runs is retained in [before-worker JSON](performance/stage5-before-worker.json) and [worker JSON](performance/stage5-worker.json); no fixture or user file is in those artifacts.

Owner QA remains: real work-laptop timing and memory observation, a large real project/DOCX/PDF, native folder selection and permissions, Windows fonts/PDF viewers/physical printing, and phone reading/quick capture with touch and a screen reader. These browser timings use genuine IndexedDB, Worker, Blob, image decode, downloads and local document conversion, with synthetic files. They do not verify the native folder picker, permission prompts, installed-app behavior, or disk-full handling.
