// usage: node cdp-click.mjs <titleSubstring> <x> <y> [clicks=2] [modifiers=0]
const [, , title, x, y, clicks = '2', mods = '0'] = process.argv;
const port = process.env.CURSOR_CDP_PORT || '9222';
const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
const t = list.find(t => t.type === 'page' && t.title.includes(title));
if (!t) { console.error('no target'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => new Promise(res => { const i = ++id; ws.addEventListener('message', function h(ev) { const m = JSON.parse(ev.data); if (m.id === i) { ws.removeEventListener('message', h); res(m); } }); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.addEventListener('open', r));
const base = { x: +x, y: +y, button: 'left', modifiers: +mods };
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +x, y: +y });
for (let c = 1; c <= +clicks; c++) {
  await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount: c });
  await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount: c });
}
ws.close();
console.log('ok', t.title);
