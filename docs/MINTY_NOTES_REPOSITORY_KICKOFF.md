# Minty Notes — repository review and first build

Reviewed November 1, 2026.

Repository: https://github.com/ClintasaurusRex/minty-notes

Reviewed `main` commit: `534b4969a947d4168ac645bc21fb8d19b96e05e1` — Added docs.

## What is present

- A public repository with 22 tracked files.
- Vite 8.3.x, React 19.3.x, and the React Compiler configuration in `vite.config.ts`.
- TypeScript constrained to `~6.0.0`, with version 6.0.3 in the lockfile. This preserves the compatibility fix for the current TypeScript ESLint dependency.
- Build, lint, development-server, and preview scripts.
- The unmodified starter demonstration in `src/App.tsx` and its starter styles/assets.
- Product plan, Claude handoff, and getting-started document under `docs/`.
- No application notebook features, persistence layer, offline setup, or automated test setup yet.
- A generic starter README; no root `CLAUDE.md` or `AGENTS.md` exists in the reviewed tree.

The local checkout matched the reviewed GitHub commit and was clean. File hashes for the inspected application/configuration files and the three planning documents matched the GitHub tree. The latest commit added only the three planning documents; the application code is the same starter whose build and lint passed during setup. Those checks were not repeated for this read-only review.

## Recommended first run

Implement the existing plan's Stage 0 and Stage 1 in this repository. Keep the working scaffold. Do not spend the first run recreating Vite, changing frameworks, or building every future feature's data-management screens.

The first milestone should let the user:

1. Open a Minty-themed notebook workspace.
2. Capture an unassigned note into Inbox.
3. Write basic rich text and paste a screenshot directly into the page.
4. Move and resize text/image containers on a growing notebook page.
5. Organize pages into notebooks and sections.
6. Reload and recover the saved content and layout.
7. Back up the complete workspace, including image bytes, and restore it into a clean workspace.
8. Reopen the completed features offline after setup.

Advanced project management, document conversion, PDF/project export, and full screenshot markup follow in the later planned stages. They must not crowd out this first recoverable notebook.

## Copy this into Claude Code with the repository selected

**Effort:** Extra high (`xhigh`) if available on the chosen model/interface; otherwise High. The first run couples editor behavior, local storage, backup recovery, and offline operation. Use Max only for a specific hard problem if the earlier attempts warrant it.

**Conversation:** Start a fresh Claude Code build conversation for this first milestone. If you have already submitted this build, keep using that conversation. Stay there through Stage 0, Stage 1, and their fixes. After completion, save the branch and progress notes before starting a new build conversation for Stage 2, using the branch that contains the completed work. Keep the Codex planning/review chat for coordination.

Work in the existing `ClintasaurusRex/minty-notes` repository. Inspect the current branch and working tree, and preserve existing work. Read `docs/MINTY_NOTES_PLAN.md`, `docs/CLAUDE_CODE_HANDOFF.md`, and `docs/START_HERE.md` before coding. Any bare planning-document names in the older handoff refer to files under `docs/`.

Implement Stage 0 followed by Stage 1 of the product plan. Continue through normal implementation decisions without stopping for routine confirmation. Stop at the checked Stage 1 milestone. Keep a runnable app throughout.

The project is already initialized with Vite, React, TypeScript, and React Compiler. Preserve that setup; do not scaffold a second app. Keep TypeScript within the supported 6.0.x range while the current linting stack requires a version below 6.1. Use the existing lockfile and begin with `npm ci`, `npm run build`, and `npm run lint` to establish the environment baseline. Check installed package requirements before adding dependencies. Do not use `--force` or `--legacy-peer-deps` to bypass incompatible dependency requirements.

Stage 0 should prove the two difficult parts before broad feature work:

- A DOM-based rich-text container can be edited, selected, moved, and resized on a growing page without drag gestures stealing text interaction. Choose and test a maintained, freely usable editor library with the current React/Compiler setup.
- Structured records and image blobs persist locally and round-trip through a validated complete backup, including the original layout and relationships. Test local-folder access and a downloadable backup fallback. Record any browser permission flow that cannot be exercised for real in the cloud environment.

Carry successful prototype code into Stage 1. Avoid implementing the full future project/task/document-import model before the notebook works. Establish a versioned data format, stable IDs, and storage boundaries that allow those later additions.

Stage 1 must deliver:

- The specified charcoal/mint Minty appearance, readable note text, visible focus, and a compact desktop workspace.
- Inbox, quick capture, standalone notes, notebooks, sections, and pages. Capturing a note never requires a project.
- Growing notebook pages with freely positioned basic rich-text and image containers. The plan's 1,200 CSS-pixel width is a prototype default to validate, not an infinite board or fixed-height slide.
- User-triggered screenshot paste, local image storage, move/resize controls, undo/redo, and keyboard alternatives for essential actions.
- Autosave with honest saving/saved/error feedback, clean reload/reopen behavior, and protection against conflicting edits from multiple app instances.
- Complete workspace backup/restore, backup-folder selection, versioned snapshots while the app is open, last-successful-backup status, permission-recovery handling, and a downloadable fallback. Validate before replacing data and preserve the existing workspace if validation fails.
- Offline startup after setup, correct caching of assets required by completed features, and an accurate offline-ready state. Save before applying app updates. Prepare for a stable HTTPS static host, without deploying.

Use IndexedDB or a well-supported wrapper for local structured data and attachment blobs. Store rich text as structured editor content with explicit canvas-object geometry; avoid treating HTML strings or localStorage as the entire database. Preserve React Compiler and use a separate vector layer when later shapes need it. Keep storage, editing, backup, and application presentation separated enough to test and extend, without adding unused framework layers.

All user content stays local. Use no project-data backend, cloud database, paid service, login, analytics, remote AI, or online document conversion. Work on a feature branch according to this environment's normal workflow; keep changes reviewable. Do not deploy or begin Stages 2–6 in this run.

Add meaningful automated checks for persistence, restore validation/recovery, geometry, and editor interactions. Verify the application in a real browser if tooling permits. The required demonstration is: capture an Inbox note → type text → paste an image → arrange it → reload → create a complete backup → restore into a clean workspace → verify text, image bytes, layout, and notebook/page links. Include invalid archives, denied/revoked folder access, and failed writes. Distinguish real-browser checks from simulated file handles; do not mark an untested permission flow as passed.

Run build, lint, and the new relevant tests after implementation. Avoid forced audit fixes or broad unrelated dependency changes; record unresolved advisories and their actual scope.

Update the README with actual setup/use instructions. Create `docs/ARCHITECTURE.md`, `docs/DATA_FORMAT.md`, and `docs/PROGRESS.md` with the decisions, completed work, verification, limitations, and exact next task. A concise root `CLAUDE.md` can point future sessions to those documents and the authorized milestone; it should not duplicate the entire product plan.

Finish with a clear report of what works, how to run it, checks performed, dependencies added, known limitations, and what remains for the Stage 2 project/reference milestone. A shell or a visual mockup alone does not complete Stage 1.

## Review after the first build

Bring back Claude's completion report and its branch or pull-request link. Review the implementation and checks against the milestone above before selecting the Stage 2 continuation prompt. A cloud session may need a separate manual Chrome check for actual folder-picker permissions on the work laptop; that limitation must be explicit.

For each subsequent prompt, state the recommended effort and whether to stay in the current build conversation or start fresh, with one short reason. Keep related debugging and failed checks in the same conversation. Start fresh at coherent completed milestone boundaries, or after a crowded conversation has saved a precise handoff. A new cloud conversation must select a branch containing the needed code, not assume unmerged work is already on `main`.

Official background: [Claude Code effort guidance](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips) and [session/context guidance](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code). The particular recommendations here are planning judgments for Minty Notes.

## Source links

- [Reviewed repository snapshot](https://github.com/ClintasaurusRex/minty-notes/tree/534b4969a947d4168ac645bc21fb8d19b96e05e1)
- [Dependency setup](https://github.com/ClintasaurusRex/minty-notes/blob/534b4969a947d4168ac645bc21fb8d19b96e05e1/package.json)
- [React Compiler setup](https://github.com/ClintasaurusRex/minty-notes/blob/534b4969a947d4168ac645bc21fb8d19b96e05e1/vite.config.ts)
- [Current starter screen](https://github.com/ClintasaurusRex/minty-notes/blob/534b4969a947d4168ac645bc21fb8d19b96e05e1/src/App.tsx)
- [Product plan in the repository](https://github.com/ClintasaurusRex/minty-notes/blob/534b4969a947d4168ac645bc21fb8d19b96e05e1/docs/MINTY_NOTES_PLAN.md)

This review prepared build instructions only. It changed no repository files, branches, commits, or deployment settings.
