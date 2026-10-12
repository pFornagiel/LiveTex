---
name: cursor-extension-playground
description: Launch, drive and screenshot an isolated Cursor IDE window (and its Extension Development Host) through Argent/CDP, to run and test LiveTex end to end. Use when you need to run the extension in Cursor, click around the Cursor UI or the PDF preview webview, take screenshots, or check that a command/notification/status bar item works.
allowed-tools: Bash(.claude/skills/cursor-extension-playground/scripts/argent.sh:*), Bash(.claude/skills/cursor-extension-playground/scripts/launch-cursor-cdp.sh:*), Bash(node .claude/skills/cursor-extension-playground/scripts/:*)
---

# Cursor extension playground

A separate Cursor instance with its own profile exposes Chrome DevTools Protocol (CDP) on `localhost:9222`. [Argent](https://github.com/software-mansion/argent) drives it as a Chromium device, so you can read the UI, click, type, run JavaScript in the workbench and take screenshots. That works for the IDE window and for the Extension Development Host (EDH) it starts with F5. Three small CDP scripts cover what Argent can't do: key chords, Ctrl/Cmd-click, and evaluating inside the preview webview.

All paths below are relative to the repository root. `SKILL_DIR` means `.claude/skills/cursor-extension-playground`.

## What exists

| Thing | Path / value |
|---|---|
| Launcher | `SKILL_DIR/scripts/launch-cursor-cdp.sh [folder]`. Opens the repository root by default. |
| Argent wrapper | `SKILL_DIR/scripts/argent.sh <argent args>`. Runs `@swmansion/argent@0.28.0` through `npx` with telemetry off (`DO_NOT_TRACK=1`). |
| CDP helpers | `SKILL_DIR/scripts/cdp-key.mjs` (chords, `insertText`), `cdp-click.mjs` (modifier clicks), `cdp-wv.mjs` (webview eval). |
| F5 config | `.vscode/launch.json` builds the extension and opens `examples/demo` in the EDH. |
| Isolated Cursor profile | `$CURSOR_CDP_PROFILE`, default `~/.config/Cursor-extdev`. See *First-time setup*. |
| CDP port | `$CURSOR_CDP_PORT`, default `9222`. The launcher, the wrapper and the helper scripts read it. |
| Argent device id | `chromium-cdp-<port>`, so `chromium-cdp-9222` by default. Every Argent tool takes it (`--udid`, or `--device_id` for `debugger-*`). |
| Extensions dir | Shared with the user's main Cursor (`~/.cursor/extensions`). Installing or removing an extension affects both. |

## Prerequisites

- `cursor` on `PATH`.
- Node 22+ (the helper scripts use the global `WebSocket`) and `npx`. The wrapper fetches Argent into the npm cache on first use, which takes about 15 s; later calls take about 1 s. Don't install Argent globally and don't run `argent init` (it registers an MCP server in the user's editor configs) without asking the user.
- Argent's own docs: `argent.sh tools` lists every tool, `argent.sh tools describe <tool>` or `argent.sh run <tool> --help` shows its flags. Only the Chromium-capable tools apply here: `describe`, `screenshot`, `gesture-tap`/`-scroll`/`-drag`, `keyboard`, `run-sequence`, `debugger-evaluate`, `chromium-tabs`, `chromium-storage`, `await-screen-idle`, `await-ui-element`, `screenshot-diff`.

## Hard rules

- **Never quit, restart or `pkill` the user's main Cursor** (profile `~/.config/Cursor`). It may host the user's agent sessions, possibly including yours. Only touch processes whose command line includes the playground profile (`--user-data-dir=…/Cursor-extdev`).
- Don't log in or out of the playground profile, and don't change its account. The user owns it.
- Port 9222 gives full control of that window to anything on localhost. Close the playground when you're done with a long task.
- `examples/demo` is the test document. Never point the EDH at a user's real project: `pdfOnSave` and **Compile Now** write `<root>.pdf` next to the root file. Work on a scratch copy instead.
- Always go through `argent.sh`, so the version stays pinned and telemetry stays off.

## First-time setup (once per machine)

If the profile directory doesn't exist yet, ask the user to run the launcher and log in to Cursor in the window that opens. A blank profile shows a login overlay (`.onboarding-v2-overlay`) that covers screenshots. After logging in, Cursor 3.x may switch to the Agents ("glass") window. To pin the IDE layout, quit the playground instance and set these keys in `$CURSOR_CDP_PROFILE/User/globalStorage/state.vscdb`, table `ItemTable`:

- `cursor/unifiedAppLayout = editor`
- `cursor/userWindowRestorationPreference = lastUsedWindows`
- `cursor/userOpenAgentsWindowOnStartupPreference = false`

```bash
sqlite3 "$DB" "insert or replace into ItemTable(key,value) values ('cursor/unifiedAppLayout','editor')"   # and so on
```

## Launch

```bash
# Already running?
curl -s localhost:9222/json/version >/dev/null && echo up || echo down

# If down: start it detached and wait for the workbench window
nohup .claude/skills/cursor-extension-playground/scripts/launch-cursor-cdp.sh > /tmp/cursor-extdev.log 2>&1 &
for i in $(seq 1 40); do curl -s localhost:9222/json/list | grep -q '"type": "page"' && break; sleep 1; done
sleep 3   # let the workbench finish rendering
```

The launcher runs `cursor --classic --new-window --user-data-dir=<profile> --remote-debugging-port=<port> <folder>`. Keep `--classic`, because without it Cursor may send the folder to the Agents window.

Cursor restores the last debug session, so the EDH may come up on its own next to the IDE window.

## Connect and look

There is no connect step. Argent probes port 9222 (and `$CURSOR_CDP_PORT`) on every call, and its first call starts a background tool-server that keeps the session, including the active tab, between calls.

```bash
.claude/skills/cursor-extension-playground/scripts/argent.sh run list-devices --json        # shows chromium-cdp-9222 when the playground is up
.claude/skills/cursor-extension-playground/scripts/argent.sh run chromium-tabs --udid chromium-cdp-9222 --action list --json
.claude/skills/cursor-extension-playground/scripts/argent.sh run chromium-tabs --udid chromium-cdp-9222 --action select --tab t2
.claude/skills/cursor-extension-playground/scripts/argent.sh run describe --udid chromium-cdp-9222
.claude/skills/cursor-extension-playground/scripts/argent.sh run screenshot --udid chromium-cdp-9222 --out /path/out.png
```

- **Tabs.** Each Cursor window is one tab. Tab ids (`t1`, `t2`, …) are assigned in the order the tool-server first sees the windows, so `t1` isn't always the IDE window. Pick by `title`: the EDH is `[Extension Development Host] …`, the IDE is `livetex - Cursor`. `select` changes the target of every later page-scoped call (`describe`, `screenshot`, `gesture-*`, `keyboard`, `debugger-evaluate`).
- **`describe`** prints the DOM/accessibility tree with **normalized** frames `(x, y, width, height)` in 0–1. Tap an element at its centre (`x + width/2`, `y + height/2`).
- **Screenshots** are about 1280×800. Use the Read tool on the file to see it. To tap something you located on a screenshot, divide the pixel position by the viewport size.

## Acting

```bash
# Click / double-click at normalized coordinates (also hits the preview webview: input is routed into the iframe)
.claude/skills/cursor-extension-playground/scripts/argent.sh run gesture-tap --udid chromium-cdp-9222 --x 0.92 --y 0.104
.claude/skills/cursor-extension-playground/scripts/argent.sh run gesture-tap --udid chromium-cdp-9222 --x 0.63 --y 0.93 --clickCount 2

# Single named keys: enter, escape, backspace, delete, tab, space, arrow-*, f1–f12. Text: printable ASCII.
.claude/skills/cursor-extension-playground/scripts/argent.sh run keyboard --udid chromium-cdp-9222 --key f5
.claude/skills/cursor-extension-playground/scripts/argent.sh run keyboard --udid chromium-cdp-9222 --text 'Hello \emph{world}' --delayMs 10

# Run JavaScript in the active window's workbench
.claude/skills/cursor-extension-playground/scripts/argent.sh run debugger-evaluate --device_id chromium-cdp-9222 --expression 'document.title' --json

# Several steps in one round trip
.claude/skills/cursor-extension-playground/scripts/argent.sh run run-sequence --udid chromium-cdp-9222 --steps-json '[{"tool":"keyboard","args":{"key":"f1"}},{"tool":"keyboard","args":{"text":"LiveTex: Open Live Preview","delayMs":10}},{"tool":"keyboard","args":{"key":"enter"}}]'
```

**Argent's `keyboard` has no modifiers.** It can't send Ctrl+S, Ctrl+Shift+P, Shift+F5 and so on. Two ways around it:

- `F1` opens the command palette like Ctrl+Shift+P does, and almost every chord has a palette command (`File: Save`, `Debug: Stop`, `Debug: Restart`, `View: Focus First Editor Group`).
- `node SKILL_DIR/scripts/cdp-key.mjs "<window title part>" <chord>...` sends real CDP key events with modifiers, for example `node .claude/skills/cursor-extension-playground/scripts/cdp-key.mjs "Extension Development Host" Control+Shift+F5`. Keys: letters, digits, `F1`–`F12`, `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `Space`, `Home`, `End`, `PageUp`, `PageDown`, `Arrow*`. Modifiers: `Control`, `Shift`, `Alt`, `Meta`. `cdp-key.mjs "<title>" --text '<text>'` uses `Input.insertText`, which types into the focused editor at once instead of key by key.

The helper scripts pick their window by title and don't depend on Argent's active tab.

## Typical test loop

1. Edit the source in `src/` or `webview/`.
2. Start the EDH. Select the IDE tab and press `F5` (`keyboard --key f5`). The pre-launch task runs `npm run build`. Then poll until a second page target appears:
   ```bash
   for i in $(seq 1 30); do [ "$(curl -s localhost:9222/json/list | grep -c '"type": "page"')" -ge 2 ] && break; sleep 1; done
   ```
   The EDH window title is `[Extension Development Host] …`, and the window has `examples/demo` open.
3. Select the EDH tab (`chromium-tabs --action list`, then `--action select --tab <its id>`), open `main.tex`, and run commands from the command palette with the `run-sequence` from *Acting* (`f1`, then the command name, then `enter`).
4. Check the result:
   - Notifications: `debugger-evaluate --expression '[...document.querySelectorAll(".notification-list-item-message")].map(e=>e.innerText)'`
   - Anything visual: take a screenshot.
   - Workbench DOM: `debugger-evaluate` with `document.querySelector…`. The workbench is ordinary DOM.
   - Preview webview DOM: see *Webviews* below.
   - To wait for something instead of sleeping, use `await-ui-element` or `await-screen-idle` (see `--help`).
5. After code changes, either reload the EDH window (palette → "Developer: Reload Window") or restart debugging from the IDE window (`cdp-key.mjs "livetex - Cursor" Control+Shift+F5`, or palette → "Debug: Restart").
6. To stop the EDH, close its window, or in the IDE window press `Shift+F5` with `cdp-key.mjs` or run "Debug: Stop".

Webviews contributed by extensions appear as extra CDP targets of type `iframe` (`vscode-webview://…`). Check `curl -s localhost:9222/json/list`. `chromium-tabs` lists only pages, not these.

## Webviews (the PDF preview)

- **The extension's DOM is one frame deeper.** The CDP `iframe` target is VS Code's webview host page, and the extension's HTML lives in its `#active-frame` child. `debugger-evaluate` only reaches the workbench page, so use `node SKILL_DIR/scripts/cdp-wv.mjs '<expr>'`. It evaluates `<expr>` with `w` (content window) and `d` (content document) bound, for example `node .claude/skills/cursor-extension-playground/scripts/cdp-wv.mjs "d.getElementById('status-text').textContent"`. Don't eval through argument shadowing (`(window, document) => …`); it gave inconsistent results.
- **Clicks reach the webview.** `gesture-tap` coordinates are relative to the whole window, and the events are routed into the webview iframe. `--clickCount 2` fires a real `dblclick`, which is how to test reverse SyncTeX (double-click in the PDF).
- **Argent can't click with modifiers.** The viewer also runs reverse SyncTeX on Ctrl/Cmd+click. To test that, use `node SKILL_DIR/scripts/cdp-click.mjs "<window title part>" <x> <y> [clicks=2] [modifiers]`. It takes **CSS pixels**, not fractions, and sends real CDP mouse events. Modifiers are a bitmask: 2 = Ctrl, 4 = Meta.
- **Occluded windows stop painting.** When the playground window isn't visible on the desktop, `requestAnimationFrame` never fires and canvas/pdf.js work stalls until something forces a frame. A screenshot forces one; `Page.startScreencast` does not. For timing measurements, call `Page.captureScreenshot` with a tiny clip every ~80 ms to simulate a visible window. Don't treat such stalls as extension bugs until you've checked that `rAF` fires. Argent turns on focus emulation when it connects, so `document.visibilityState` reads `visible` even then. That's why its gesture tools don't refuse to work, but it doesn't make frames paint.
- **Dirty buffers don't survive "Developer: Reload Window" in the EDH.** Re-type test edits after a reload.
- **Native save/open dialogs can't be driven over CDP.** Temporarily put `{"files.simpleDialog.enable": true}` in the test folder's `.vscode/settings.json` to get the in-window dialog (for example, for **Export PDF…**), then remove it.
- **Modal message boxes (`showWarningMessage(..., { modal: true })`) are native too**, so they are invisible to screenshots and can't be clicked. `window.dialogStyle` is application-scoped, so a workspace setting does nothing. Back up `$CURSOR_CDP_PROFILE/User/settings.json`, add `"window.dialogStyle": "custom"`, restart the playground, and restore the backup afterwards. Click dialog buttons with `debugger-evaluate` on `.monaco-dialog-box .monaco-button`, not by coordinates, because the dimmed overlay sits on top.
- **Status bar items** (for example, the Overleaf item): click them with `debugger-evaluate` (`[...document.querySelectorAll(".statusbar-item")].find(e => /Text/.test(e.innerText)).click()`), or with `gesture-tap` on the frame `describe` reports. Clicking moves focus away from the editor, so press `Control+1` (`cdp-key.mjs`) before typing into the editor again.

## Gotchas

- **Agents window instead of IDE.** If the IDE layout regresses, re-apply the `state.vscdb` keys from *First-time setup*. A fresh login also triggers `glassDefaultOnLogin`, which opens the Agents window once and closes the IDE window.
- **The `describe` tree and the pixels can disagree** with some custom UI, such as the login overlay. Fall back to `debugger-evaluate` with `document.elementFromPoint(x,y)` or a text search, and to screenshots.
- **The layout can change between calls.** Panels open and close (for example, when the user touches the window, or when a command reveals a view). Take coordinates from a fresh `describe` or screenshot, not from one taken several steps earlier.
- **zsh doesn't word-split variables.** `A="…/argent.sh run"; $A screenshot` fails with "command not found". Use a shell function or write commands out in full.
- **`pgrep -f`/`pkill -f` match their own shell**, because the pattern is in the shell's command line. Use a bracket pattern such as `Cursor-extde[v]`.
- `--remote-debugging-port` prints "not in the list of known options". That's harmless; Electron still honours it.
- **A non-default `$CURSOR_CDP_PORT` reaches Argent only when its tool-server starts.** If the server is already running from an earlier session, run `argent.sh server stop` first. The device id becomes `chromium-cdp-<port>`.

## Shut down

```bash
.claude/skills/cursor-extension-playground/scripts/argent.sh server stop   # Argent's tool-server doesn't exit on its own
pkill -f 'user-data-dir=.*Cursor-extde[v]'   # playground only; never a broader pattern
# Run pkill in a Bash call of its own: if the same command line also mentions the profile path or the pattern's
# target, pkill -f matches (and kills) your own shell. Killing the main electron PID from pgrep works too.
```
