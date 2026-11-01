# Minty Notes — project plan, version 1

Status: planning specification, November 1, 2026. User preferences are recorded below; architectural and workflow defaults selected during planning are identified separately. This document is ready for a build handoff. Application implementation and deployment have not started.

## Purpose

A personal workspace for technical projects and reusable knowledge, with the Minty Fresh Codeworks visual identity. Open an active project and see its own notes, relevant technical references, project files, and next actions together.

Typical work includes VTScada, Studio 5000, Weidmüller, custom White Pacific tools, and control-panel construction. These are starting categories, not a fixed list. Projects can use several system categories.

## Confirmed direction

- Name: Minty Notes.
- Personal use initially.
- Desktop first, primarily Chrome, with one main computer holding the working data.
- Phone-friendly access is a secondary goal; automatic cross-device synchronization is not required initially.
- No project-data backend and no monthly hosting bill.
- Notes, project data, and imported files are saved on the computer.
- Optional Linux and Windows desktop applications come at the end.
- Reuse the cleanup tool's charcoal surfaces, mint accents, restrained borders, clean typography, and compact controls.
- Notes use growing notebook pages with freely positioned text and images, rather than an infinite board.
- Editing should include familiar Slides-style positioning, resizing, shapes, and annotation controls.
- Reference organization: notebooks → sections → pages, plus tags.
- Project system categories automatically surface relevant reference material, with manual adjustments.
- Rich text, headings, tables, checklists, code snippets, inline images, links, and templates are desired.
- Tasks have due dates, priorities, and a To do / Doing / Done board.
- Preserve imported originals and offer editable note conversion for Word files and text-based PDFs.
- Screenshot tools should cover arrows, boxes, circles, text labels, pen, highlighter, crop, and blur/redaction, with simple wiring-style sketches also desired.
- Project details include customer, site, job number, status, due date, contacts, Dropbox location, equipment, and software versions.
- Save backups to a chosen local folder, potentially inside Dropbox, when browser access is available.
- Pasting screenshots directly into pages is a core workflow.
- Quick capture supports notes that have no project association.
- Exports: note-to-PDF, portable project packages, and full workspace backup/restore.
- Expected eventual library size is unknown; use representative test datasets rather than inventing a user requirement or promising unlimited storage.

## Decisions made on the user's behalf

These are recommended defaults. The user delegated the reference-link decision and requested a recommendation for app delivery.

### Delivery: installable, offline-capable browser app

Start with a static web app at one stable HTTPS address. Configure it as an installable progressive web app (PWA), so Chrome can launch it in its own window on Windows or Linux. Cache the application for offline use after setup. Installation is optional; ordinary Chrome access must work too.

The host serves application files only. Notes, imported attachments, project records, and search indexes stay in local browser storage. No account, project-data API, subscription service, analytics, AI API, or online document conversion is needed. Select a no-cost static hosting option at deployment time; no provider is selected or deployment authorized by this plan.

Show an accurate offline-readiness state. Cache the assets needed for promised offline features, including document converters, workers, fonts, and icons. Online Dropbox links still require a network connection. Do not claim that a first-ever visit can launch offline.

Keep updates user-controlled when edits are open: save first, then activate a ready update. An app update must preserve existing local data and validate migrations. A new hosting address needs an explicit export/restore migration because browser storage belongs to the original address.

This provides an app-like launch before native desktop packaging is necessary. It still uses browser-managed storage, so folder backups remain essential.

### References remain linked

Projects show the original reference page rather than silently creating duplicates. Changes to that page are reflected wherever it is linked. A clear “Reference library” label distinguishes it from a project-owned note. Editing a shared reference makes its wider effect visible. “Make a project copy” creates an independent page when project-specific changes are needed.

### Matching uses explicit categories

Notebook or section categories such as VTScada determine suggested references. This is a predictable local rule, without an AI service. Users can pin extra pages and hide irrelevant suggestions for a project. Hiding a suggestion does not delete the source page.

### Project files have distinct roles

- Imported attachment: Minty Notes stores its own copy, includes it in backups, and can preview supported formats.
- External file or folder reference: Minty Notes stores the location or authorized folder handle. The source remains outside the planner.
- Dropbox web link: opens the referenced resource in Dropbox.
- Local path: visible and copyable, useful for opening a location through the operating system.

An authorized local-folder browser is a later enhancement. Do not promise that arbitrary Windows paths will open directly from a webpage, or that industrial project files can be edited inside Minty Notes.

## Main screens

### Home

Active projects, upcoming and overdue tasks, recently opened notes, and pinned references. Project cards show the customer/site, status, system categories, and next task. Starting a quick note or opening the last page should be easy. An empty installation opens with helpful examples that can be removed.

### Inbox and general notes

Quick capture is available from the main app navigation and from within a project. A note can be saved immediately without selecting a project, notebook, category, or tag. Its initial destination is an Inbox, with a generated editable title and capture time.

Later, move it into a general notebook or project, or leave it as a standalone note. Moving a page preserves its ID and links. A page's owner is either general or one project; additional projects can reference it without duplicating the content. General notes are a first-class part of the app, not unfinished project records.

Pasting a screenshot into an open page inserts an image object near the current insertion point or visible selection. In an empty quick note, paste creates the first image object. Use the ordinary user-triggered paste flow; do not require continuous clipboard monitoring. Imported images are stored locally and included in backups.

### Projects

Searchable and filterable projects with active and archived states. A project opens to an overview containing its details, useful reference pages, pinned project notes, file locations, and next tasks.

Project navigation provides Overview, Notes, Tasks, and Files. Archiving preserves the complete project. Deletion uses a recoverable trash stage.

### Reference library

Notebooks, sections, and pages, with tags and system categories. Start with empty notebooks or editable example structures for VTScada, Studio 5000, Weidmüller, custom tools, and panel building. Do not invent technical reference content.

Project notes use the same page editor but have a project owner. General notes can remain outside a project.

### Page editor

A compact toolbar, notebook/page navigation, a large work surface, and contextual controls for the current selection. Side panels can collapse to maximize writing space.

A page begins at a comfortable readable width and grows downward as content is added. It is not a slide deck and has no fixed slide height. The initial editor prototype must establish how wide layouts, page boundaries, zoom, and printing behave before these rules are finalized.

Freely positioned containers hold rich text, screenshots, images, code snippets, and shapes. Text wraps within a resizable container; adding text grows the container. Support moving and resizing objects, ordering overlaps, duplication, deletion, undo/redo, and keyboard alternatives to dragging. Selection handles must not interfere with text selection and editing.

Paste images and text from the clipboard, or import/drag in local files. Preserve ordinary text-paste behavior while editing a text container. Pasting an image uses the page's placement rules rather than silently replacing selected text.

Initial geometry defaults to validate in Stage 0: a 1,200 CSS-pixel page width with a fit-to-width view; page height expands as needed. Keep all objects within the chosen page width and at nonnegative positions. Resizing text changes wrapping and lets height grow. Optional snapping and alignment guides help place objects. Any page-width control must preserve existing content and avoid cropping it. PDF pagination uses this same explicit geometry.

### Tasks

A project board and a combined task list across projects. Each task has a title, status, priority, optional due date, notes, and an optional linked note page. Provide accessible move controls alongside drag-and-drop.

Start with date-based deadlines and visible upcoming/overdue indicators. Background notifications, calendar synchronization, recurring tasks, and time tracking are later scope unless requested.

### Search

Proposed default: search project details, page titles, note text, tags, task titles, and attachment names. Converted document text becomes searchable note content. Search results identify whether an item is a project note, reference page, task, or attachment.

Do not silently crawl linked Dropbox folders. Searching the full contents of original attachments is separate from searching converted notes and can be added later.

### Settings and data

Choose a backup folder, view last successful save and backup, create a backup now, restore a backup, and inspect storage usage. Show clearly when a backup folder needs to be reselected or access renewed.

## Navigation and everyday flow

Primary navigation: Home · Inbox · Projects · Notebooks · Tasks · Search · Settings.

Example day:

1. Open Home and select the current VTScada project.
2. Read its next task and open a relevant linked VTScada reference page.
3. Create a project note, paste a screenshot, add an arrow and explanation, and link the note to the task.
4. Copy the project's local Dropbox folder path, or open its Dropbox web link.
5. Capture an unrelated useful tip into Inbox without leaving it attached to the current project.
6. See that changes are saved locally and the backup status is current.

## Visual direction

Carry the existing cleanup tool's design language into a notebook layout. Starting palette observed in the current tool: background `#0b0f0e`, panels `#131918`, raised controls `#1a2220`, borders `#26302e`, main text `#e4ece9`, secondary text `#9badaa`, and mint accent `#6ee7b7`.

Use system fonts, monospace for code, 6–12px corner radii, restrained motion, and visible keyboard focus. Note text should be more comfortably readable than compact toolbar labels. A charcoal page sits clearly within the darker workspace; selected objects use mint outlines. Avoid making every panel or paragraph a mint-colored card.

Desktop layout: narrow main navigation, collapsible notebook/page navigation, compact top toolbar, central page, and contextual properties only when useful. Small screens prioritize opening, reading, searching, and quick capture; a wide note retains its geometry rather than rearranging saved objects.

## Local storage and recovery

Recommended foundation: React and TypeScript with a static frontend build; IndexedDB for structured records and attachment blobs; a service worker for the offline application; and Chrome folder access for backups. Library choices for rich text, local database access, archives, and document conversion must be verified during Stage 0. Favor maintained, freely usable libraries without paid feature requirements. Use a stable app address so an update does not accidentally create a separate browser workspace.

Use an HTML/DOM rich-text layer for editable containers and an SVG or equivalent vector layer for shapes and annotations. Do not paint the entire text editor into a bitmap canvas. Prototype interactions before committing to an editor dependency. No need for a collaboration engine, server-rendering stack, or cloud database in this version.

Keep the data layer separate from the user interface so a future desktop shell can reuse the product and adopt native storage. Version the data format from the first working release.

Required behavior:

- Autosave note, canvas, task, and project changes without relying solely on closing a tab.
- Request browser persistent storage and accurately report whether it was granted; backups must work regardless.
- Prevent conflicting writes from two open copies of the same workspace, using a single-editor lock or an equally reliable coordination strategy.
- Clearly distinguish saved, saving, and failed-to-save states.
- Retain stable IDs for pages, projects, objects, attachments, and links.
- Handle failed writes and storage limits without claiming the change was saved.
- Keep imported originals separate from their editable conversions.
- Backups include relationships, tags, rich text, canvas layout, tasks, annotation data, and imported attachments.
- External folder contents are excluded unless deliberately imported.
- Use versioned backup snapshots rather than overwriting the only copy. Initial proposal: a manual backup action plus automatic snapshots every 30 minutes while the app is open and changes exist, with the last 10 successful snapshots retained. Validate this policy in the storage prototype. Never prune an older snapshot until the new one completes successfully.
- Do not promise unattended backups while the app is closed. After reopening, check whether a backup is due and whether folder access remains available.
- If folder access is unavailable, preserve the working data and offer a downloadable backup.
- Restore validates the archive before applying changes and provides a review of what will be restored.
- Initial restore can replace a workspace after safeguarding the existing one. Merging workspaces is later scope.
- Prove that a complete backup restores correctly into a clean workspace, including images and reference links.

Local saving does not automatically put data on another computer or phone. A backup file stored in a Dropbox-synced folder can be transported by Dropbox, but this is not live multi-device editing or conflict resolution.

### Data model boundaries

Core records: WorkspaceSettings, Project, SystemCategory, Notebook, Section, Page, CanvasObject, Attachment, Tag, Task, ExternalLocation, ReferenceAssociation, and Template. Links use stable IDs rather than titles or folder names.

Pages keep their rich-text content and canvas geometry. Attachment bytes are stored separately and referenced by ID. Date-only task deadlines remain date-only values. A project stores its selected system categories and its reference pin/hide overrides. Imported originals retain filename, type, size, and import metadata. Portable exports contain a versioned manifest and the required records/assets; device-specific folder permissions are never treated as portable credentials.

### Working scale targets

The user has no size estimate. Begin with a test fixture of 50 projects, 1,000 note pages, 1,000 tasks, and roughly 250 MB of imported assets. Include a demanding page with 100 mixed objects and 15 images. These are engineering test targets, not product limits or promises about available disk space.

Measure startup, project opening, search, typing/dragging, and backup/restore on a documented machine. Use lazy loading and thumbnails so opening the workspace does not decode every image. Establish measured performance budgets after Stage 0, and increase the fixture when practical. Handle browser quota exhaustion independently of these targets.

## Document imports

Target DOCX, PDF with selectable text, plain text/Markdown, and common image formats. Confirm legacy .doc requirements before adding another converter. Online document links can be stored; direct Google Docs account integration is not part of the initial import flow.

An import should preserve the original, identify its type, offer a preview where supported, and let the user create an editable note. Conversion produces a draft for review. Word structure and embedded images should be retained where feasible; complex layouts and PDF reading order may require cleanup. Exact reproduction of the original document's layout is not an acceptance requirement.

Run conversion locally. Scanned-document OCR and handwriting recognition are later enhancements. Failed conversion must leave the original available and explain which part did not import.

Treat imported content as untrusted: imported formatting must not execute scripts or fetch remote resources unexpectedly. Large conversions should not freeze the editor.

## Agreed exports

### Note PDF

Export one note with a title and deliberate pagination, preserving visible text, images, and annotations. Include a preview so the user can review page breaks and wide content. Do not silently clip overflowing objects or shrink a long page into one unreadable sheet. Validate with text, tables, overlapping objects, and multi-page notes.

### Portable project package

Include the project, its owned notes, tasks, imported attachments, file-location records, and a snapshot of references needed to understand it. A snapshot must not remain invisibly dependent on another workspace. Keep external file paths and web links as references; exclude the contents of unimported folders. Explain that original imported assets may be present, including originals behind edited images.

Import first previews the package. IDs are remapped when necessary, preserving internal relationships and preventing an unrelated local page from being overwritten. Shared library pages require an explicit choice to reuse a matching original or import an independent reference snapshot.

### Full workspace backup

Preserve all workspace records and imported assets for recovery. This differs from a portable project export and does not function as a safe-to-share redacted document. Backup restore validates version, archive structure, and relationships before replacing working data.

PNG/image and editable Markdown exports can be added later. They are not part of the selected first export set.

## Images and annotations

Store original images and editable annotation objects separately. Users can revise arrows, labels, shapes, and sketches later. Image export flattens the chosen view; notebook backup retains editable objects.

Decide the export behavior of redaction explicitly. A properly redacted exported image must remove covered pixels rather than only hide them beneath removable shapes. An editable workspace backup can still contain the original and is not a sanitized sharing format.

Wiring-style sketches initially mean lines, arrows, labels, shapes, and freehand drawing. Electrical CAD, automatic routing, and validated electrical symbols are separate future work.

## Suggested build sequence

Each stage must leave a runnable app and document its completed behavior, checks, limitations, and next step. Do not spend the entire remaining usage budget on setup before proving the core workflow.

### Stage 0 — resolve the risky interactions

Build small disposable proofs for rich text inside movable/resizable containers, text selection versus object dragging, local image persistence, folder backup permissions, and a complete backup/restore round trip. Verify an offline launch using the proposed delivery method.

Output: a short architecture decision record and a decision to keep or revise the editor/storage approach. Do not attempt full features in this stage.

### Stage 1 — useful notebook core

Minty shell, Inbox and standalone notes, notebooks/sections/pages, basic rich-text containers, screenshot paste, freely positioned images, autosave, save-status feedback, local attachments, undo/redo, and backup/restore. Create an unassigned note, paste a screenshot, move it, reload, and recover it from backup in a clean workspace.

This is the first independently useful milestone.

### Stage 2 — projects and reusable knowledge

Project details, multiple system categories, project-owned pages, linked reference pages, automatic reference suggestions, pin/hide controls, project copies, tags, search, home dashboard, archive, and trash.

Verify that changing one linked reference updates its presentation across projects while an independent copy stays unchanged.

### Stage 3 — tasks and project workflow

Task boards, due dates, priorities, all-project task view, note links, file locations, Dropbox web links, and reusable note/project templates. Daily work logs remain an optional later enhancement.

Verify a realistic VTScada project workflow from project creation through notes, references, files, tasks, and archive.

### Stage 4 — richer pages and document import

Complete tables, code snippets, internal page links, drawing and annotation tools, DOCX/PDF conversion, original previews, note-to-PDF, and portable project export/import. Full backup/restore already exists from Stage 1. Preserve originals and conversion drafts. Handle malformed and large files gracefully.

Divide this stage into independently checked slices: rich text and page links; image annotation and sketches; document import; note PDF; project package round trip. Keep a runnable app after each slice rather than attempting the entire stage as one change.

### Stage 5 — polish and optional enhancements

Refine shortcuts, responsive layouts, print/export behavior, performance on realistic datasets, and accessibility. Add authorized local-folder browsing if it remains useful. Phone layouts should help users navigate and read wide pages without rearranging the desktop layout.

### Stage 6 — optional desktop packaging

Evaluate Linux and Windows packaging only after the browser product is stable. Verify offline startup, native folder access, update behavior, and migration from existing browser data. Distribution and signing choices need their own plan.

## Verification that matters

- Actual Chrome use on the intended work environment.
- Reopen after a reload or browser restart without losing notes, attachments, canvas positions, or edits.
- Recovery from a complete backup in a clean workspace.
- Permission loss, canceled imports, interrupted saves, invalid backups, and storage-full handling.
- Text editing, selection, dragging, resizing, undo, clipboard actions, and keyboard navigation work together.
- Linked references and independent project copies behave differently and visibly.
- Due dates do not shift unexpectedly with time-zone handling.
- Representative DOCX/PDF imports preserve originals and produce understandable editable drafts.
- Imported text cannot execute active content.
- Performance targets use the user's expected project, page, and attachment volumes.
- Offline behavior matches the chosen delivery method.

## Budget and delivery constraints

Claude Code usage expires November 5. More than $80 was available when discussed, with some reserved for the cleanup tool; the final remaining amount is unknown. Do not equate a dollar amount with a guaranteed feature count or completion date.

Prioritize completed, recoverable stages. Notebook editing and reliable storage come before integrations and desktop packaging. Record progress and next actions in the repository so a later session can resume without reconstructing decisions.

## Remaining implementation choices

No further product answers are required to start the planned prototype. Resolve these through implementation evidence:

- Rich-text, database, archive, and conversion library choices and licenses.
- Final page-width/zoom and PDF pagination behavior after testing representative notes.
- Measured performance budgets on a documented machine.
- Whether the proposed backup interval and retention suit real archive sizes.
- Static host and final address when deployment is requested.
- Native desktop shell and distribution only in the optional final stage.

Implementation should proceed through the stages above after a separate build instruction. This planning task has produced no application code and deployed nothing.

## Technical references checked during planning

- [MDN: browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [MDN: local folder picker and support constraints](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
- [MDN: File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
- [Dropbox: optional Chooser integration](https://docs.dropboxapi.com/dropbox-api/docs/pre-built-components/chooser)
- [web.dev: PWA installation on desktop](https://web.dev/learn/pwa/installation/)
- [web.dev: caching for offline use](https://web.dev/learn/pwa/caching/)
- [MDN: requesting persistent browser storage](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)

These document browser and service capabilities. They do not imply that Dropbox integration, device synchronization, or hosted deployment has been approved or implemented.
