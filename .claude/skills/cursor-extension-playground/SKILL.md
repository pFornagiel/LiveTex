---
name: cursor-extension-playground
description: Launch, drive and screenshot an isolated Cursor IDE window (and its Extension Development Host) through agent-browser/CDP, to run and test LiveTex end to end. Use when you need to run the extension in Cursor, click around the Cursor UI or the PDF preview webview, take screenshots, or check that a command/notification/status bar item works.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*), Bash(npx -y agent-browser@0.39.0:*), Bash(.claude/skills/cursor-extension-playground/scripts/launch-cursor-cdp.sh:*), Bash(node .claude/skills/cursor-extension-playground/scripts/:*)
---

# Cursor extension playground

A separate Cursor instance with its own profile exposes Chrome DevTools Protocol (CDP) on `localhost:9222`. `agent-browser` connects to it, so you can read the UI, click, type, run JavaScript in the workbench and take screenshots. That works for the IDE window and for the Extension Development Host (EDH) it starts with F5.

All paths below are relative to the repository root. `SKILL_DIR` means `.claude/skills/cursor-extension-playground`.

## What exists

| Thing | Path / value |
|---|---|
| Launcher | `SKILL_DIR/scripts/launch-cursor-cdp.sh [folder]`. Opens the repository root by default. |
| F5 config | `.vscode/launch.json` builds the extension and opens `examples/demo` in the EDH. |
| Isolated Cursor profile | `$CURSOR_CDP_PROFILE`, default `~/.config/Cursor-extdev`. See *First-time setup*. |
| CDP port | `$CURSOR_CDP_PORT`, default `9222`. The launcher and both helper scripts read it. |
| Extensions dir | Shared with the user's main Cursor (`~/.cursor/extensions`). Installing or removing an extension affects both. |

## Prerequisites

- `cursor` on `PATH`.
- **agent-browser ≥ 0.39.** The commands below are written for 0.39; older versions differ (for example, `tab` wants bare integers). Check with `agent-browser --version`. If it's missing or older, write `npx -y agent-browser@0.39.0` wherever this file says `agent-browser`. Don't install anything system-wide without asking the user. Its general usage guide comes from the CLI itself: `agent-browser skills get core`, or `agent-browser skills get electron` for the Electron-specific part.
- Node 22+ for the helper scripts, which use the global `WebSocket`.

## Hard rules

- **Never quit, restart or `pkill` the user's main Cursor** (profile `~/.config/Cursor`). It may host the user's agent sessions, possibly including yours. Only touch processes whose command line includes the playground profile (`--user-data-dir=…/Cursor-extdev`).
- Don't log in or out of the playground profile, and don't change its account. The user owns it.
- Port 9222 gives full control of that window to anything on localhost. Close the playground when you're done with a long task.
- `examples/demo` is the test document. Never point the EDH at a user's real project: `pdfOnSave` and **Compile Now** write `<root>.pdf` next to the root file. Work on a scratch copy instead.

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

## Connect and look

```bash
agent-browser --session cursor connect 9222
agent-browser --session cursor tab                 # t1 = IDE window, t2 = EDH once started
agent-browser --session cursor tab t1              # 0.39 wants ids like t1/t2, not bare integers
agent-browser --session cursor snapshot -i         # interactive elements with @eN refs
agent-browser --session cursor screenshot /path/out.png
agent-browser --session cursor close               # only disconnects; Cursor stays open
```

Use the Read tool on the screenshot to see it. The viewport is about 1280×800.

## Typical test loop

1. Edit the source in `src/` or `webview/`.
2. Start the EDH. In the IDE tab (`tab t1`), press `F5`. The pre-launch task runs `npm run build`. Then poll until a second page target appears:
   ```bash
   for i in $(seq 1 30); do [ "$(curl -s localhost:9222/json/list | grep -c '"type": "page"')" -ge 2 ] && break; sleep 1; done
   ```
   The EDH window title is `[Extension Development Host] …`, and the window has `examples/demo` open.
3. Switch to it with `tab t2`, open `main.tex`, and run commands from the command palette:
   ```bash
   agent-browser --session cursor press Control+Shift+p
   agent-browser --session cursor keyboard type "LiveTex: Open Live Preview"
   agent-browser --session cursor press Enter
   ```
4. Check the result:
   - Notifications: `agent-browser --session cursor eval '[...document.querySelectorAll(".notification-list-item-message")].map(e=>e.innerText)'`
   - Anything visual: take a screenshot.
   - Workbench DOM: `eval` with `document.querySelector…`. The workbench is ordinary DOM.
   - Preview webview DOM: see *Webviews* below.
5. After code changes, either reload the EDH window (in `t2`, palette → "Developer: Reload Window") or restart debugging from `t1` (`Control+Shift+F5`).
6. To stop the EDH, close its window or press `Shift+F5` in `t1`.

Webviews contributed by extensions appear as extra CDP targets of type `iframe` (`vscode-webview://…`). Check `curl -s localhost:9222/json/list`.

## Webviews (the PDF preview)

- **The extension's DOM is one frame deeper.** The CDP `iframe` target is VS Code's webview host page, and the extension's HTML lives in its `#active-frame` child. `node SKILL_DIR/scripts/cdp-wv.mjs '<expr>'` evaluates `<expr>` with `w` (content window) and `d` (content document) bound, for example `node .claude/skills/cursor-extension-playground/scripts/cdp-wv.mjs "d.getElementById('status-text').textContent"`. Don't eval through argument shadowing (`(window, document) => …`); it gave inconsistent results.
- **agent-browser can't double-click or click with modifiers** (`mouse down/up` always sends `clickCount: 1`, so no `dblclick` event fires). `node SKILL_DIR/scripts/cdp-click.mjs "<window title part>" <x> <y> [clicks=2] [modifiers]` sends real CDP mouse events. Modifiers are a bitmask: 2 = Ctrl, 4 = Meta. Use it to test reverse SyncTeX (double-click in the PDF).
- **Occluded windows stop painting.** When the playground window isn't visible on the desktop, `requestAnimationFrame` never fires and canvas/pdf.js work stalls until something forces a frame. A screenshot forces one; `Page.startScreencast` does not. For timing measurements, call `Page.captureScreenshot` with a tiny clip every ~80 ms to simulate a visible window. Don't treat such stalls as extension bugs until you've checked that `rAF` fires.
- **Dirty buffers don't survive "Developer: Reload Window" in the EDH.** Re-type test edits after a reload.
- **Native save/open dialogs can't be driven over CDP.** Temporarily put `{"files.simpleDialog.enable": true}` in the test folder's `.vscode/settings.json` to get the in-window dialog (for example, for **Export PDF…**), then remove it.
- **Modal message boxes (`showWarningMessage(..., { modal: true })`) are native too**, so they are invisible to screenshots and can't be clicked. `window.dialogStyle` is application-scoped, so a workspace setting does nothing. Back up `$CURSOR_CDP_PROFILE/User/settings.json`, add `"window.dialogStyle": "custom"`, restart the playground, and restore the backup afterwards. Click dialog buttons with `eval` on `.monaco-dialog-box .monaco-button`; `find text … click` is blocked by the dimmed overlay.
- **Status bar items** (for example, the Overleaf item): click them with `eval` (`[...document.querySelectorAll(".statusbar-item")].find(e => /Text/.test(e.innerText))`), because `find text` can hit other elements. Clicking moves focus away from the editor, so press `Control+1` before typing into the editor again.
- **Input:** `Input.insertText` on the page target types into the focused editor without the keystroke delays of `keyboard type`.

## Gotchas

- **Agents window instead of IDE.** If the IDE layout regresses, re-apply the `state.vscdb` keys from *First-time setup*. A fresh login also triggers `glassDefaultOnLogin`, which opens the Agents window once and closes the IDE window.
- **`snapshot -i` misses some custom UI**, including the login overlay's buttons, so the element tree and the pixels can disagree. Fall back to `eval` with `document.elementFromPoint(x,y)` or a text search, and to screenshots.
- **zsh doesn't word-split variables.** `AB="agent-browser --session cursor"; $AB tab` fails with "command not found". Use a shell function or write commands out in full.
- **`pgrep -f`/`pkill -f` match their own shell**, because the pattern is in the shell's command line. Use a bracket pattern such as `Cursor-extde[v]`.
- `--remote-debugging-port` prints "not in the list of known options". That's harmless; Electron still honours it.

## Shut down

```bash
pkill -f 'user-data-dir=.*Cursor-extde[v]'   # playground only; never a broader pattern
# Run pkill in a Bash call of its own: if the same command line also mentions the profile path or the pattern's
# target, pkill -f matches (and kills) your own shell. Killing the main electron PID from pgrep works too.
```
