// usage: node cdp-key.mjs <titleSubstring> <chord>...        e.g. Control+Shift+P  Shift+F5  Control+1
//        node cdp-key.mjs <titleSubstring> --text '<text>'   Input.insertText into the focused element
const [, , title, ...args] = process.argv;
const port = process.env.CURSOR_CDP_PORT || '9222';
const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
const t = list.find(t => t.type === 'page' && t.title.includes(title));
if (!t) { console.error('no target'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => new Promise(res => { const i = ++id; ws.addEventListener('message', function h(ev) { const m = JSON.parse(ev.data); if (m.id === i) { ws.removeEventListener('message', h); res(m); } }); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.addEventListener('open', r));

const MODS = { Alt: [1, 'AltLeft', 18], Control: [2, 'ControlLeft', 17], Meta: [4, 'MetaLeft', 91], Shift: [8, 'ShiftLeft', 16] };
const NAMED = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
function keyDesc(k) {
  if (/^[a-z]$/i.test(k)) return { key: k.toLowerCase(), code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(k)) return { key: k, code: `Digit${k}`, windowsVirtualKeyCode: k.charCodeAt(0) };
  if (/^F([1-9]|1[0-2])$/.test(k)) return { key: k, code: k, windowsVirtualKeyCode: 111 + +k.slice(1) };
  if (k in NAMED) return { key: k === 'Space' ? ' ' : k, code: k, windowsVirtualKeyCode: NAMED[k] };
  console.error(`unknown key "${k}"`); process.exit(1);
}

if (args[0] === '--text') {
  await send('Input.insertText', { text: args[1] ?? '' });
} else {
  for (const chord of args) {
    const parts = chord.split('+');
    const mods = parts.slice(0, -1);
    const main = keyDesc(parts.at(-1));
    let bits = 0;
    for (const m of mods) {
      if (!MODS[m]) { console.error(`unknown modifier "${m}"`); process.exit(1); }
      bits |= MODS[m][0];
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: m, code: MODS[m][1], windowsVirtualKeyCode: MODS[m][2], modifiers: bits });
    }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...main, modifiers: bits });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...main, modifiers: bits });
    for (const m of mods.reverse()) {
      bits &= ~MODS[m][0];
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: m, code: MODS[m][1], windowsVirtualKeyCode: MODS[m][2], modifiers: bits });
    }
  }
}
ws.close();
console.log('ok', t.title);
