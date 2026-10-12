# Changelog

## 0.4.0

- Renamed the extension from LaTeX Live Preview to **LiveTex**. The extension ID is now `local.livetex`.
- All command and setting IDs moved from `latexLive.*` to `livetex.*`. Existing `latexLive.*` settings are not migrated; rename them in your `settings.json`.

## 0.3.0

- Two-way sync with Overleaf projects through Overleaf's Git integration: link a folder, clone a project, sync, abort a merge, open the project on Overleaf, and manage Git tokens.
- New settings `overleaf.autoPull` and `overleaf.pushOnSave`.
- Build options that travel with the document: the `% !TEX program` magic comment and a project `latexmkrc`.

## 0.2.0

- Live PDF preview compiled from unsaved buffers through a shadow copy, with Tectonic or an installed TeX distribution via `latexmk`.
- SyncTeX in both directions, Export PDF, and the PDF written next to the root file on save.
- Fast single-pass preview builds and cached flattened copies of large transparent PNGs.
- Root document detection, a compiler log, and errors in the Problems panel.
