// usage: node cdp-wv.mjs '<expression using w (content window) and d (content document)>'
const port = process.env.CURSOR_CDP_PORT || '9222';
const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
for (const t of list.filter(t => t.type === 'iframe' && t.url.startsWith('vscode-webview://'))) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const expr = `(() => { const f = document.getElementById('active-frame'); const w = f.contentWindow, d = f.contentDocument; return (${process.argv[2]}); })()`;
  const res = await new Promise(res => { ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id === 1) res(m); }); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  console.log(JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails?.exception?.description ?? res));
  ws.close();
}
