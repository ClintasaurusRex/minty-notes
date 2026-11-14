# Test files: genuine archives from real writers

Binary fixtures for the archive-safety and compatibility tests (`src/backup/archiveCompat.test.ts`, `src/import/import.test.ts`, the browser tests). All content is synthetic — no customer or personal files. Made on November 13, 2026.

## `backups/`

- `minty-<version>-backup.zip` — one workspace backup written by **each release's own code**: the source of that release was exported with `git archive <commit>` into a scratch folder (no branch change), and its own `freshStore` → store → repository → `BackupService.createArchive()` wrote the file (fflate 0.8.3, the writer every release used). Content: a notebook and section, two pages, a text box, a 1×1 PNG screenshot; from 0.2.0 also a project, category, tag, and project note; from 0.3.0 a task.

  | File | Commit | Data format |
  |---|---|---|
  | `minty-0.1.0-backup.zip` | `304c2d5` | 1 |
  | `minty-0.1.1-backup.zip` | `0f28457` | 1 |
  | `minty-0.1.2-backup.zip` | `3af576f` | 1 |
  | `minty-0.2.0-backup.zip` | `6c76d3b` | 2 |
  | `minty-0.2.1-backup.zip` | `da8796e` | 2 |
  | `minty-0.3.0-backup.zip` | `d23b379` | 3 |
  | `minty-0.4.0-backup.zip` | `2733193` | 4 |
  | `minty-0.4.1-backup.zip` | `074d503` | 4 |

- `repacked-*.zip` — `minty-0.4.1-backup.zip` unpacked and zipped again by common tools, as a user might: Info-ZIP 3.0 with folder entries, its usual extra fields and an archive comment (`zip -r`, `zip -z`); Info-ZIP with data descriptors (`zip -fd`); Info-ZIP with ZIP64 records (`zip -fz`, full ZIP64 end records); 7-Zip 16.02 with NTFS times (`7z a -tzip -mtc=on`); Python 3 `zipfile` streamed to an unseekable file with `force_zip64=True` (data descriptors and ZIP64 local headers).

## `docx/`

A short procedure (heading, bold/italic, list, table) converted to DOCX by **LibreOffice 24.2** (`soffice --headless --convert-to docx`, run with a throw-away user profile): `libreoffice-24.2.docx` (data descriptors, flags `0x0808`). The same parts zipped again by Info-ZIP (`infozip-extras-comment.docx`, `infozip-descriptors.docx`, `infozip-zip64.docx`), 7-Zip (`7zip-ntfs-times.docx`), and Python `zipfile` (`python-stream-zip64.docx`, `python-stored-comment.docx` with archive and file comments, every part stored).

Documents written by Microsoft Word are not copied here: the tests use the Word files that ship with mammoth (`node_modules/mammoth/test/test-data/*.docx`, BSD-2-Clause), which use Word's own ZIP layout (flags `0x0006`, `0xA220` padding fields in the local headers).
