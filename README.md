# LiveTex

Overleaf-style LaTeX editing inside VS Code and Cursor. Your `.tex` files stay ordinary editor tabs, and a PDF preview sits next to them. The preview recompiles from your unsaved buffers about a second after you stop typing.

- **Live preview while typing.** Unsaved buffers are compiled from a shadow copy, so your files on disk are never touched. Edits to included chapters work too.
- **Watches the disk.** Changes made by git, scripts or AI agents are picked up and recompiled without touching the editor.
- **Overleaf-compatible when you have TeX installed.** If TeX Live, TinyTeX, MacTeX or MiKTeX is found (even when it isn't on the editor's PATH), documents are built with `latexmk` (pdfLaTeX, biber or BibTeX, current packages), just like Overleaf.
- **Zero-setup otherwise.** Without a TeX distribution it uses [Tectonic](https://tectonic-typesetting.github.io): one self-contained binary that downloads the LaTeX packages a document needs on first use.
- **SyncTeX in both directions.** Double-click (or Ctrl/Cmd-click) in the PDF to jump to the source. Moving the cursor highlights the matching spot in the PDF.
- **Errors where you work.** TeX errors and warnings appear in the Problems panel, on the right file and line, even inside `\input` files. The PDF still renders despite errors, as on Overleaf.
- **PDF output.** Saving writes `<root>.pdf` next to the root file. The **PDF** button exports a copy anywhere.
- **Multi-file projects.** `% !TEX root = ../main.tex` magic comments are supported, and the root is auto-detected when another file `\input`s the current one.
- **Per-document engine.** `% !TEX program = xelatex` (or `pdflatex`, `lualatex`) chooses the engine, using the same magic comment as TeXShop, TeXworks, TeXstudio and LaTeX Workshop.
- **Project `latexmkrc`.** A `latexmkrc` (or `.latexmkrc`) next to the root document is used, as on Overleaf.
- **Two-way sync with Overleaf.** Through Overleaf's Git integration: link a local folder or clone a project, then sync from the status bar. Conflicts are shown in the editor, and nothing is ever force-pushed.

## Getting started

1. Open a `.tex` file and click the preview icon in the editor title bar (or press `Ctrl+K V`, or run **LiveTex: Open Live Preview**).
2. If no TeX engine is found, the extension offers to **download Tectonic 0.17.0**. It is the official static binary from GitHub, about 10–23 MB, SHA-256 verified. It lives in the extension's private storage, and nothing is installed system-wide.
3. The first compile downloads the packages your document uses into Tectonic's cache (`~/.cache/tectonic` on Linux). This takes 30–100 s for a typical article. After that, rebuilds take about a second.

Already have TeX Live, TinyTeX, MacTeX or MiKTeX? Nothing to do: it is detected (PATH, `~/.TinyTeX`, `/usr/local/texlive/*`, `/Library/TeX/texbin`, MiKTeX) and preferred. Point `livetex.texBinPath` at its `bin` directory if it lives somewhere unusual.

### Which engine should I use?

| Your document… | Use |
|---|---|
| compiles on Overleaf with the default pdfLaTeX, uses `biblatex`/biber, `\usepackage[T1]{fontenc}`/`inputenc`, `times`… | a TeX distribution (`latexmk`). TinyTeX is a small option. |
| is simple or XeTeX-style (`fontspec`), and you don't want to install TeX | Tectonic (automatic download) |

When Tectonic is used on a document it can't reproduce, the Problems panel says why (for example biblatex/biber, or pdfLaTeX-only encodings).

## Project build options

Two conventions travel with the project and are understood by other tools, so there is no extra config file:

- **`% !TEX program = pdflatex | xelatex | lualatex`** near the top of the root document picks the engine. TeXShop's `% !TeX TS-program = …` spelling works too. With Tectonic, which only runs XeLaTeX, a document that asks for pdfLaTeX or LuaLaTeX gets a warning in the Problems panel.
- **`latexmkrc`** (or `.latexmkrc`) in the root document's folder is passed to latexmk, as Overleaf does. It applies to full builds, which are saves, opening the preview and **Compile Now**. While such a file exists, typing also uses full latexmk builds instead of the faster single pass, because the file can change how the engine has to be called.

When they disagree, the more specific one wins: `% !TEX program` beats the latexmkrc, which beats the `latexmkArgs` setting. Output and aux directories are always set by the extension, so a latexmkrc that sets `$out_dir` or `$aux_dir` can't scatter build files into your project. A latexmkrc is Perl code that latexmk executes. It is only used in trusted workspaces (VS Code's Workspace Trust), and it is run in the extension's build directory, not in your project folder.

## Sync with Overleaf

This uses Overleaf's official [Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git), which needs an Overleaf plan that includes it (personal or institutional). Overleaf Server Pro 4.0+ with Git enabled works too.

1. On Overleaf, create a Git token: **Account Settings → Git Integration**.
2. Run one of these:
   - **LiveTex: Clone Overleaf Project…** to start from an Overleaf project. It goes into a new folder.
   - **LiveTex: Link Folder to Overleaf Project…** to connect an existing local folder (also in the Explorer's right-click menu on a folder).
3. Paste the project URL from the browser (or its Git URL or ID), then the token. The token is stored in VS Code's secret storage. It is passed only to the git process for that command, never written to `.git/config` or a git credential store.

Linking first shows exactly which files will be uploaded and asks for confirmation. Local files are kept as they are, Overleaf's files are downloaded next to them, and nothing is deleted on either side. A file that exists on both sides with different content becomes a merge conflict.

**How a folder is recognised.** There is no extra config file: a folder counts as an Overleaf project when it is a git repository with a remote named `overleaf`, or a remote on an Overleaf host (for example `https://git.overleaf.com/<id>`). Link and Clone set this up; a clone you made yourself with `git clone https://git.overleaf.com/…` is recognised too. Detection covers the workspace folders and the document shown in the preview, and it is repeated when the window gets focus.

**Where you see it.**
- The **☁ Overleaf** status bar item.
- A cloud button in the preview toolbar: green when up to date, `↑` with changes to upload, `↓n` with Overleaf changes waiting, orange with conflicts. Click it to sync.
- A ☁ badge on the project folder in the Explorer when the project is a subfolder or part of a multi-root workspace. (A single-folder window shows its root as the section header, which can't carry badges.)

The indicators also update when files are changed outside the editor, for example by git, scripts or agents.

**Syncing.** Click the **☁ Overleaf** status bar item or the preview's cloud button (or run **LiveTex: Sync with Overleaf**). It does the following:

1. Saves the project's open files.
2. Commits local changes.
3. Merges Overleaf's changes.
4. Uploads.

The item shows `↓n` when Overleaf has changes waiting and `↑` when you have local changes that aren't uploaded yet.

**Conflicts.** If the same lines changed on both sides, nothing is uploaded. The file shows the usual conflict markers, and the editor's merge tools work. Resolve the markers, save, and sync again. Or run **LiveTex: Abort Overleaf Merge** to return to your local version; Overleaf's changes stay on Overleaf until the next sync.

**Automatic behaviour.**
- `livetex.overleaf.autoPull` (on by default) downloads Overleaf changes when the window gains focus, at most every 2 minutes. It only fast-forwards and never uploads. It is skipped while you have unsaved edits or local changes that the incoming changes would touch.
- `livetex.overleaf.pushOnSave` (off by default) runs a full sync 15 s after the last save.

**What isn't uploaded.** Build output (`.aux`, `.log`, `.synctex.gz`, `.bbl` and similar), the root PDF that `pdfOnSave` writes, and `.vscode/`. These are listed in `.git/info/exclude`, so the Overleaf project gets no `.gitignore`. Other PDFs, for example figures, are synced normally.

**Overleaf's Git limits apply.** There is one branch, no Git LFS and no submodules. Renames arrive as delete and add, which drops Overleaf comments and tracked changes on that file. Overleaf advises against mixing Git with track-changes.

## How it works

```
 editor buffers ──(debounce 250 ms)──► shadow dir: root.tex + unsaved files (+ last .aux/.bbl)
                                         │  tectonic -Z search-path=<project dir> --synctex
                                         ▼
 Problems panel ◄── parsed errors     out/: root.pdf, root.synctex.gz
                                         │  postMessage(bytes)
                                         ▼
                              webview: pdf.js renders off-screen, then swaps canvases (no flicker)
```

- **Shadow compilation.** Each build writes the root file and every *unsaved* buffer under the project folder into a scratch directory. Tectonic's `-Z search-path` points at the real project for everything else: images, `.bib` files, saved chapters.
- **Fast keystroke builds.** While you type, a single TeX pass reuses the previous build's `.aux`/`.bbl`, so references and citations stay resolved. With Tectonic these files are seeded into the shadow dir. With latexmk the engine (pdfLaTeX) runs directly, skipping latexmk's dependency analysis and extra passes. Saves, opening the preview, and **Compile Now** run the full logic (reruns, biber/BibTeX), so the PDF written to disk is always complete.
- **Preview image cache.** Large transparent PNGs (typically screenshots) are re-encoded by TeX on every compile, and that is often most of the build time. For preview builds only, a background worker flattens them onto white once (cached), and the copies are linked into the shadow dir. Saved, manually compiled and exported PDFs always use your original images.
- **Coalescing.** At most one build runs at a time, and one more is queued. Bursts of edits collapse into the newest state.
- **Rendering.** pdf.js renders each page into an off-screen canvas, then swaps it in, keeping your scroll position. Only visible pages (±1) are rendered.

Measured on Linux x64:

| Document | Engine | Keystroke → updated page |
|---|---|---|
| Bundled demo (amsmath, TikZ, hyperref, BibTeX; 2 pages) | Tectonic | ~1.4 s |
| 49-page thesis (biblatex/biber, 35 PNG screenshots, 18 MB of images) | latexmk + TinyTeX | ~3.5–4 s (a single pass was 10 s before the image cache; a full latexmk cycle takes ~20 s) |

## Commands

| Command | Default key |
|---|---|
| LiveTex: Open Live Preview | `Ctrl+K V` |
| LiveTex: Compile Now | `Ctrl+Alt+Enter` |
| LiveTex: Export PDF… | — |
| LiveTex: Show Cursor Position in PDF | — |
| LiveTex: Use This File as Root Document | — |
| LiveTex: Download Tectonic Engine | — |
| LiveTex: Show Compiler Output | — |
| LiveTex: Sync with Overleaf | click the Overleaf status bar item |
| LiveTex: Link Folder to Overleaf Project… / Clone Overleaf Project… | — |
| LiveTex: Abort Overleaf Merge (Keep Local Version) | — |
| LiveTex: Open Project on Overleaf | — |
| LiveTex: Set Overleaf Git Token… / Forget Overleaf Git Tokens | — |

In the preview: `Ctrl +`/`Ctrl -`/`Ctrl 0` or Ctrl+wheel zoom, and clicking the zoom label returns to fit-width.

## Settings

| Setting | Default | |
|---|---|---|
| `livetex.engine` | `auto` | `auto` (installed TeX if found, else Tectonic) · `tectonic` · `latexmk` |
| `livetex.texBinPath` | `""` | `bin` directory of your TeX distribution, if not auto-detected |
| `livetex.tectonicPath` | `""` | Use a specific tectonic binary |
| `livetex.compileOn` | `change` | `change` (live) · `save` · `manual` |
| `livetex.debounceMs` | `250` | Idle time before a live rebuild |
| `livetex.fastPreview` | `true` | Single pass reusing .aux/.bbl while typing |
| `livetex.previewImageOptimization` | `true` | Flattened copies of large transparent PNGs for preview builds |
| `livetex.continueOnErrors` | `true` | Still produce a PDF when TeX reports errors |
| `livetex.pdfOnSave` | `true` | Write `<root>.pdf` next to the root on save |
| `livetex.syncOnCursorMove` | `true` | Highlight the cursor's position in the PDF |
| `livetex.shellEscape` | `false` | Enable `\write18` (minted etc.). Only for trusted documents |
| `livetex.rootFile` | `""` | Force a root document (workspace-relative) |
| `livetex.invertPdfInDarkTheme` | `false` | Dark-mode friendly page colours |
| `livetex.latexmkArgs` | `-pdf -synctex=1 …` | Default args for latexmk. A project latexmkrc and `% !TEX program` take precedence |
| `livetex.overleaf.autoPull` | `true` | Download Overleaf changes on window focus (fast-forward only, never uploads) |
| `livetex.overleaf.pushOnSave` | `false` | Full Overleaf sync 15 s after the last save |

## Limitations

- Tectonic is XeTeX-based and bundles a 2022 TeX Live snapshot. Documents written for pdfLaTeX (`fontenc`/`inputenc` with Type 1 fonts) lose non-ASCII characters, and `biblatex` needs `biber`, which Tectonic can't pair with. Use a TeX distribution for those; the extension then picks latexmk automatically.
- Preview builds show transparent PNGs flattened onto white. This is only visible where such an image sits on a coloured background, and never in saved or exported PDFs.

## Development

```bash
npm install
npm run build        # bundles dist/extension.js and media/viewer.js, copies pdf.js assets
npm run typecheck
npm test             # SyncTeX, log parser, compatibility checks, PNG flattening, Overleaf sync against a local git server
npm run package      # produces livetex-<version>.vsix
```

Press **F5** to start an Extension Development Host on `examples/demo`.

For agent-driven end-to-end testing in Cursor (screenshots, clicking through the preview webview), see the Claude Code skill in [`.claude/skills/cursor-extension-playground`](.claude/skills/cursor-extension-playground/SKILL.md).

Third-party: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) is bundled in `media/`. Tectonic (MIT) is downloaded at runtime and not bundled.
