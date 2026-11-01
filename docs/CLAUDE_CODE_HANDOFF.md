# Minty Notes — Claude Code handoff

Prepared November 1, 2026. The full product specification is `MINTY_NOTES_PLAN.md`. This file explains how to begin a separate implementation session; it does not mean implementation has already started.

## Give Claude Code these files

Place `MINTY_NOTES_PLAN.md` and this handoff in a new, separate Minty Notes repository, or attach them where the coding environment can read them. The implementation environment needs these actual files; a link into the planning computer's local filesystem will not provide access.

Use the specification as the product source of truth. The cleanup tool's repository is a separate project. Do not modify it, assume its unfinished work can be reused, or make it a dependency. The palette and visual requirements needed to begin are already included in the specification.

## First build instruction — copy into Claude Code

**Effort:** Extra high (`xhigh`) if the selected model/interface offers it; otherwise High. This run combines editor architecture, persistence, recovery, and browser verification. Reserve Max for a specific difficult problem if normal attempts show it is needed.

**Conversation:** Start a fresh Claude Code build conversation with the repository selected. If this build is already running, stay in that conversation. Keep Stage 0, Stage 1, and fixes to that milestone together. Keep this Codex planning/review chat for coordination.

> Build the first useful milestone of Minty Notes using `MINTY_NOTES_PLAN.md` as the source of truth. Read the specification fully before coding. This is a new personal notes-and-project workspace, separate from the Minty cleanup tool.
>
> Implement Stage 0 followed by Stage 1. Make normal implementation decisions autonomously and record them; ask only if a genuine blocker or a material product change requires my decision. Do not stop after writing a plan or setting up an empty shell. The result must be a runnable notebook with reliable local data and demonstrated recovery.
>
> Stage 0 must prove rich text inside movable/resizable containers, text editing versus dragging, screenshot persistence, local folder backup behavior, and a complete backup/restore round trip. Choose maintained free libraries and verify their licenses and current documentation. Prefer React and TypeScript, IndexedDB for records and attachment blobs, DOM-based rich text, and a vector overlay for shapes. Record the final choices and their tradeoffs. Keep successful prototype code where it is useful instead of rebuilding it unnecessarily.
>
> Stage 1 must include the Minty dark/mint shell; Inbox and unassigned notes; notebooks, sections, and pages; freely positioned basic rich-text and image objects on growing notebook pages; ordinary screenshot paste; moving/resizing; undo/redo; autosave with truthful save/error feedback; local attachment storage; backup-folder selection; and complete backup/restore with a downloadable fallback. A note must work without any project association.
>
> Prepare the app for a stable HTTPS static host and offline use after setup. Do not deploy it. Verify offline startup using the local production build and a stable test origin. Cache all assets needed for the features actually completed. Installing from Chrome is optional; the browser version must remain usable. Keep all user content local: no backend, cloud database, account system, paid service, analytics, AI API, or remote document conversion.
>
> Prioritize the complete vertical workflow: create an Inbox note → write text → paste a screenshot → arrange it → reload and reopen → create a backup → restore into a clean workspace → confirm the note, image, and layout match. Demonstrate this workflow before expanding the feature set.
>
> Use meaningful automated checks for persistence, archive validation, recovery, geometry, and editor interactions, plus real-browser verification where available. Test failure paths including denied folder access, invalid archives, and failed writes. Do not claim an OS/browser permission flow was tested if it was only simulated. Document the remaining manual check in that case.
>
> Keep the app runnable throughout. Maintain `docs/PROGRESS.md` with completed work, verification, known limitations, and the exact next task. Add setup/run instructions and small architecture/data-format notes. Existing user files must be preserved if this environment is not empty.
>
> Stop after Stage 1 is implemented and checked. Report what works, how to run it, the checks performed, remaining limitations, and the next stage. Do not claim the entire product is finished. Do not begin later stages, add native desktop packaging, or publish anything in this initial run. Follow the environment's existing Git policy; deployment and changes to unrelated repositories are outside this instruction.

## Continuation instructions

Choose the next instruction only after reviewing the prior milestone. Each instruction authorizes its named work. Existing working data must survive every stage.

Effort recommendations below are starting points, not permanent settings; reassess each actual prompt based on its scope and the latest completion report. Use the effort control available in the chosen Claude Code interface rather than assuming prompt wording changes the configured effort.

Start a fresh build conversation at a clean milestone boundary once changes have been saved on a branch and `docs/PROGRESS.md` is current. Select the branch containing that completed work; a new session on an older `main` branch will not automatically have unmerged work. Stay in the current conversation for related fixes, failed checks, and finishing its assigned milestone. If context becomes crowded mid-milestone, first save the work and write a handoff covering branch/commit, completed work, attempted fixes, failed or unrun checks, limitations, and the exact next action.

### Projects and reusable references

**Effort:** High. Reconsider Extra high for a follow-up involving difficult reference/data-migration failures.

**Conversation:** Start fresh after Stage 1 and its fixes are complete and saved. Load the branch containing the notebook implementation and read its progress/architecture notes. Stay in this new conversation for Stage 2 fixes.

> Continue Minty Notes with Stage 2 in `MINTY_NOTES_PLAN.md`. First inspect the current app, progress notes, and existing data format. Implement project details, multiple system categories, project-owned pages, shared reference links, category-based suggestions, pin/hide controls, independent project copies, tags, search, the home dashboard, archive, and recoverable trash. Keep general notes fully usable. Prove that editing a shared reference updates every linked view, while editing a project copy leaves the original unchanged. Update progress notes, run appropriate checks, and stop at the completed Stage 2 milestone. Do not deploy.

### Tasks and everyday project use

**Effort:** High for the full feature milestone; Medium for a later narrowly scoped label, spacing, or straightforward UI fix.

**Conversation:** Start fresh after Stage 2 is complete and saved. Continue in that conversation while resolving Stage 3 checks or related bugs.

> Continue with Stage 3. Implement To do / Doing / Done task boards, priorities, optional date-only deadlines, a combined task list, task-to-note links, local file paths, Dropbox web links, and reusable note/project templates. Exercise a realistic project workflow using synthetic example data. Verify that tasks retain their intended date and that keyboard users can move tasks without dragging. Preserve existing notes and backups, update progress notes, and stop after the checked milestone. Do not deploy.

### Richer notes and document conversion

**Effort:** Extra high (`xhigh`) if available; otherwise High. Editor interactions, annotations, and local document conversion introduce several coupled failure paths.

**Conversation:** Start fresh after Stage 3 is complete and saved. Keep each feature slice and its fixes together. If this three-slice run becomes crowded, finish a slice, save its handoff, and start fresh for the next slice rather than abandoning an unexplained partial change.

> Continue Stage 4 in small checked slices: rich text/tables/code/internal links; image markup and simple sketches; local DOCX and text-based PDF import with preserved originals and editable conversion drafts. Complete each slice in a runnable state before continuing. Include arrows, shapes, labels, pen/highlighter, crop, and well-defined blur/redaction behavior. Do not add OCR or handwriting recognition. Verify malformed-file handling and sanitize imported rich content. Update progress notes and stop after these three slices; PDF and portable project export are the next separate checkpoint. Do not deploy.

### PDF and project portability

**Effort:** Extra high (`xhigh`) if available; otherwise High. Pagination, redaction, ID remapping, and complete project recovery warrant deeper reasoning.

**Conversation:** Start fresh once the preceding Stage 4 slices are complete and saved. Keep export/import failures and round-trip verification in this conversation until resolved.

> Complete Stage 4 with note-to-PDF and portable project export/import as defined in the specification. Keep full workspace recovery separate from project portability. Test PDF pagination with long and wide notes, and remove redacted pixels from visual exports. A portable project must include required reference snapshots and imported attachments, remap IDs safely on import, and preserve internal links. Clearly identify excluded external-folder contents and included originals. Prove a project package round trip into a different workspace without corrupting unrelated records. Update progress notes and stop at this checkpoint. Do not deploy.

### Polish and folder browsing

**Effort:** High for this combined verification/integration milestone. Use Medium if a later prompt is limited to an isolated cosmetic change; reassess difficult performance or data-loss bugs separately.

**Conversation:** Start fresh after export/import is complete and saved. Stay in the same conversation for the issues uncovered by this polish pass.

> Implement Stage 5 against the actual completed features and recorded limitations. Refine accessibility, keyboard actions, responsive reading/quick capture, offline readiness, updates, print/export quality, and performance. Use the specification's initial synthetic dataset and report actual measurements. Add Chrome local-folder browsing if the basic file-path/link workflow is already solid. Keep folder access scoped to explicit user selection, handle renewed permissions, and do not promise direct editing of industrial application files. Record anything unverified on a real work laptop. Stop after the checked polish milestone. Do not add automatic device synchronization or native packaging, and do not deploy.

## Scope reminders

- This is a notebook with growing freeform pages, not an infinite whiteboard or a fixed-height slide deck.
- Standalone notes and project notes are equally valid.
- Automatic reference suggestions use categories, without a paid AI feature.
- Browser-local storage is the working copy; a selected backup folder holds recoverable snapshots.
- Backup timing applies while the app is open. Never promise scheduled backups while it is closed.
- A Dropbox-synced backup file does not provide simultaneous multi-device editing.
- Phone layouts can show a separate local workspace; automatic access to the desktop's notes is not included initially.
- Raw Windows paths can be copied. Do not advertise arbitrary folder-path links as universally clickable in a browser.
- DOCX/PDF conversion produces editable drafts, not exact page-layout replicas.
- Project exports may contain original attachments. PDF/image redaction and editable archive content have different purposes.
- OCR, handwriting recognition, Google account integration, live Dropbox API integration, cross-device synchronization, collaboration, electrical CAD, and native desktop packaging are later scope.

## When the remaining usage is getting low

Finish the current coherent slice, run its meaningful checks, and leave a runnable app. Preserve source files, dependency lockfiles, progress notes, data-format decisions, and exact remaining tasks in the repository. A reliable notebook with verified recovery is a useful result even if the optional stages must wait.

Do not manufacture busywork to consume credits or make a completion promise based on the remaining dollar amount.

## Effort and conversation references

These recommendations are tailored judgments for Minty Notes, not guarantees of completion time or cost. Available effort levels depend on the selected model/interface.

- [Anthropic: Claude Code effort guidance](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips)
- [Anthropic: session context and when to start fresh](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)
