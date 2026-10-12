# LiveTex - Live LaTeX Preview for VS Code and Cursor

LiveTex is a VS Code and Cursor extension that allows you to preview the live changes made to your `.tex` files and export them as PDF directly inside your editor. Projects can also be kept in two-way sync with Overleaf through its Git integration.

If a TeX distribution is installed, LiveTex builds with `latexmk`, and if not, it downloads the self-contained
[Tectonic](https://tectonic-typesetting.github.io) engine.

> Just to be clear, this project is a **personal utility made using Claude**, as I found no local TeX software that would fit my needs and integrate with the IDE well. The software is provided as is with no warrancy of any kind.

[Features](#features) · [Installation](#installation) · [Getting started](#getting-started) · [Sync with Overleaf](#sync-with-overleaf) · [Development](#development)

![LiveTex live preview with SyncTeX highlighting](docs/screenshots/preview.png)

## Features

- **Live preview** - changes rendered and synchronised as you type in another tab.
- **SyncTeX support** - double-click (or Ctrl/Cmd-click) in the PDF to jump to the source, moving the cursor also highlights the matching spot in the PDF.
- **Overleaf-compatible builds** - TeX Live, TinyTeX, MacTeX and MiKTeX are detected automatically, documents are built with `latexmk` (pdfLaTeX, biber or BibTeX).
- **Overleaf sync** - link a local folder or clone an Overleaf project in order to sync local changes.
- **Automatic setup** - If a TeX distribution is installed, LiveTex builds with `latexmk`, and if not, it downloads the self-contained [Tectonic](https://tectonic-typesetting.github.io) engine.
- **Multi-file projects** - when you edit a chapter, LiveTex finds and compiles the main document automatically or you can point to it with a `% !TEX root = main.tex` comment. A `% !TEX program = xelatex` comment picks the engine for a document, and a `latexmkrc` file in the project folder is used, as on Overleaf.
- **PDF output** - saving writes `<root>.pdf` next to the root file, and the **PDF** button exports a copy anywhere.
- **Errors output** - TeX errors and warnings land in the Problems panel on the right file and line, and the PDF still renders despite errors.



## Installation



### Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.90 or newer, or [Cursor](https://cursor.com/)
- *Optional:* a TeX distribution ([TeX Live](https://tug.org/texlive/), [TinyTeX](https://yihui.org/tinytex/), [MacTeX](https://tug.org/mactex/) or [MiKTeX](https://miktex.org/)). Without one, LiveTex uses Tectonic.
- *Optional:* [Git](https://git-scm.com/), for syncing with Overleaf

> [!NOTE]
> LiveTex is not yet published on the VS Code Marketplace or Open VSX. For now, install it from a `.vsix` file.



### From a release

Download `livetex-<version>.vsix` from the [Releases tab](https://github.com/pFornagiel/livetex/releases), then install it from the command line:

```bash
code --install-extension livetex-0.4.0.vsix     # VS Code
cursor --install-extension livetex-0.4.0.vsix   # Cursor
```

Or run **Extensions: Install from VSIX…** from the Command Palette.

### From source

Building the package requires Node.js 22 or newer:

```bash
git clone https://github.com/pFornagiel/livetex.git
cd livetex
npm install
npm run package
code --install-extension livetex-0.4.0.vsix
```



## Getting started

1. Open a `.tex` file and click the preview icon in the editor title bar, press `Ctrl+K V`, or run **LiveTex: Open Live Preview**.
2. If no TeX engine is found, LiveTex offers to **download Tectonic 0.17.0** (the official static binary from GitHub). It is kept in the extension's private storage, and nothing is installed system-wide.
3. The first compile downloads the packages your document uses into Tectonic's cache (`~/.cache/tectonic` on Linux). This takes 30–100 s for a typical article; after that, rebuilds take about a second.

If you already have a TeX distribution installed, it is detected (`PATH`, `~/.TinyTeX`, `/usr/local/texlive/*`, `/Library/TeX/texbin`, MiKTeX) and preferred. If it lives somewhere unusual, point `livetex.texBinPath` at its `bin` directory.

### Project build options

LiveTex doesn't add its own config file and reads the same build settings that Overleaf and other LaTeX editors do:

- `% !TEX program = xelatex` (or `pdflatex`, `lualatex`) at the top of the main document chooses the engine.
- `latexmkrc` in the project folder customises latexmk, just like on Overleaf.

These take priority over the `livetex.latexmkArgs` setting.

> [!IMPORTANT]
> A `latexmkrc` can run arbitrary code, so LiveTex only uses it in [trusted workspaces](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust).



## Sync with Overleaf

Syncing uses Overleaf's official [Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git), which needs an Overleaf plan that includes it (personal or institutional). Overleaf Server Pro 4.0+ with Git enabled works too.

### Connecting a project

1. On Overleaf, create a Git token: **Account Settings -> Git Integration**.
2. Run one of these commands:
  - **LiveTex: Clone Overleaf Project…** to start from an Overleaf project in a new folder.
  - **LiveTex: Link Folder to Overleaf Project…** to connect an existing local folder (also available in the Explorer's right-click menu).
3. Paste the project URL from the browser (or its Git URL or ID), then the token.

The token is stored in VS Code's secret storage. Linking first shows exactly which files will be uploaded and asks for confirmation. 

A folder counts as an Overleaf project when it is a git repository with a remote named `overleaf`, or a remote on an Overleaf host (for example `https://git.overleaf.com/<id>`).

### Syncing

Click the **Overleaf** status bar item or the cloud button in the preview toolbar, or run **LiveTex: Sync with Overleaf**. LiveTex then saves the project's open files, commits local changes, merges Overleaf's changes and uploads.

If the same lines changed on both sides causing a conflict, nothing is uploaded. The file shows the usual conflict markers and the editor's merge tools work. Resolve them, save, and sync again, or run **LiveTex: Abort Overleaf Merge** to return to your local version.

Files that are **not** uploaded include: build output (`.aux`, `.log`, `.synctex.gz`, `.bbl` and similar), the root PDF written on save, and `.vscode/`. These are listed in `.git/info/exclude`, so the Overleaf project gets no `.gitignore`. Other PDFs, such as figures, are synced normally.

## Commands

![LiveTex commands in the Command Palette](docs/screenshots/commands.png)


| Command                                                             | Default key                        |
| ------------------------------------------------------------------- | ---------------------------------- |
| LiveTex: Open Live Preview                                          | `Ctrl+K V`                         |
| LiveTex: Compile Now                                                | `Ctrl+Alt+Enter`                   |
| LiveTex: Export PDF…                                                | —                                  |
| LiveTex: Show Cursor Position in PDF                                | —                                  |
| LiveTex: Use This File as Root Document                             | —                                  |
| LiveTex: Download Tectonic Engine                                   | —                                  |
| LiveTex: Show Compiler Output                                       | —                                  |
| LiveTex: Sync with Overleaf                                         | click the Overleaf status bar item |
| LiveTex: Link Folder to Overleaf Project… / Clone Overleaf Project… | —                                  |
| LiveTex: Abort Overleaf Merge (Keep Local Version)                  | —                                  |
| LiveTex: Open Project on Overleaf                                   | —                                  |
| LiveTex: Set Overleaf Git Token… / Forget Overleaf Git Tokens       | —                                  |


In the preview, `Ctrl +` / `Ctrl -` / `Ctrl 0` or Ctrl+wheel zoom, and clicking the zoom label returns to fit-width.

## Settings

All `livetex.*` settings


| Setting                            | Default             | Description                                                                        |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `livetex.engine`                   | `auto`              | `auto` (installed TeX if found, else Tectonic) · `tectonic` · `latexmk`            |
| `livetex.texBinPath`               | `""`                | `bin` directory of your TeX distribution, if not auto-detected                     |
| `livetex.tectonicPath`             | `""`                | Use a specific tectonic binary                                                     |
| `livetex.compileOn`                | `change`            | `change` (live) · `save` · `manual`                                                |
| `livetex.debounceMs`               | `250`               | Idle time before a live rebuild                                                    |
| `livetex.fastPreview`              | `true`              | Single pass reusing `.aux`/`.bbl` while typing                                     |
| `livetex.previewImageOptimization` | `true`              | Flattened copies of large transparent PNGs for preview builds                      |
| `livetex.continueOnErrors`         | `true`              | Still produce a PDF when TeX reports errors                                        |
| `livetex.pdfOnSave`                | `true`              | Write `<root>.pdf` next to the root on save                                        |
| `livetex.syncOnCursorMove`         | `true`              | Highlight the cursor's position in the PDF                                         |
| `livetex.shellEscape`              | `false`             | Enable `\write18` (minted etc.). Only for trusted documents                        |
| `livetex.rootFile`                 | `""`                | Force a root document (workspace-relative)                                         |
| `livetex.invertPdfInDarkTheme`     | `false`             | Dark-mode friendly page colours                                                    |
| `livetex.latexmkArgs`              | `-pdf -synctex=1 …` | Default args for latexmk. A project latexmkrc and `% !TEX program` take precedence |
| `livetex.overleaf.autoPull`        | `true`              | Download Overleaf changes on window focus (fast-forward only, never uploads)       |
| `livetex.overleaf.pushOnSave`      | `false`             | Full Overleaf sync 15 s after the last save                                        |




## Development



### Prerequisites

- Node.js 22 or newer with npm
- VS Code or Cursor
- Git (the Overleaf sync tests run against a local git server)



### Setup

```bash
git clone https://github.com/pFornagiel/livetex.git
cd livetex
npm install
npm run build
```

`npm run build` bundles `dist/extension.js`, `dist/flattenWorker.js` and the webview's `media/viewer.js` with esbuild, and copies the pdf.js runtime assets into `media/`.

### Running the extension

Open the repository in VS Code or Cursor and press **F5**. This builds the extension and starts an Extension Development Host with the bundled demo document in `[examples/demo](examples/demo)` open.

For a faster loop, keep a watcher running and reload the development host window (**Developer: Reload Window**) after each change:

```bash
npm run watch
```



### Tests and static checks

```bash
npm run typecheck   # extension and webview
npm test            # SyncTeX, log parser, project options, PNG flattening, Overleaf sync
```



### Packaging

```bash
npm run package
```

This produces a minified `livetex-<version>.vsix`. The Marketplace page is generated from `[MARKETPLACE.md](MARKETPLACE.md)`, not from this README.

### End-to-end testing with agents

For agent-driven testing in Cursor (screenshots, clicking through the preview webview), see the Claude Code skill in `[.claude/skills/cursor-extension-playground](.claude/skills/cursor-extension-playground/SKILL.md)`.

## Limitations

- Tectonic is XeTeX-based and bundles a 2022 TeX Live snapshot. Documents written for pdfLaTeX (`fontenc`/`inputenc` with Type 1 fonts) lose non-ASCII characters, and `biblatex` needs `biber`, which Tectonic can't pair with. Use a TeX distribution for those; LiveTex then picks latexmk automatically.
- Preview builds show transparent PNGs flattened onto white. This is only visible where such an image sits on a coloured background, and never in saved or exported PDFs.



## Acknowledgements

- [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) renders the preview and is bundled in `media/`.
- [Tectonic](https://tectonic-typesetting.github.io) (MIT) is downloaded at runtime and not bundled.



## License

[MIT](LICENSE)