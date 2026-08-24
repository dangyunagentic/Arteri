// Screenshot the custom overlay system: open Keys page, click Delete -> confirm dialog,
// click Confirm -> toast. Uses CDP WebSocket (Bun-native).
const COOKIE = process.argv[2];
const OUT = process.argv[4] ?? "/tmp/shots";
const URL_BASE = "http://127.0.0.1:8787";

const put = await fetch("http://127.0.0.1:9223/json/new?about:blank", { method: "PUT" });
const target = await put.json();
const wsUrl = target.webSocketDebuggerUrl;
if (!wsUrl) {
  console.error("no ws url", target);
  process.exit(1);
}

let id = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
function send(method: string, params: any = {}): Promise<any> {
  return new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Network.setCookie", {
  name: "arteri_admin",
  value: COOKIE,
  domain: "127.0.0.1",
  path: "/",
});
await send("Page.navigate", { url: `${URL_BASE}/console/keys` });
await sleep(2500);

// click the first visible "Delete" button on the page
const clicked = await send("Runtime.evaluate", {
  expression: `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Delete'); if(!b) return 'none'; b.click(); return 'clicked'; })()`,
  returnByValue: true,
});
console.log("delete btn:", clicked.result?.result?.value);
await sleep(500);

let shot = await send("Page.captureScreenshot", { format: "png" });
await Bun.write(`${OUT}/confirm-dialog.png`, Buffer.from(shot.result.data, "base64"));
console.log("saved confirm-dialog.png");

// confirm it -> toast should appear
await send("Runtime.evaluate", {
  expression: `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Confirm'); if(!b) return 'none'; b.click(); return 'ok'; })()`,
  returnByValue: true,
});
await sleep(600);
shot = await send("Page.captureScreenshot", { format: "png" });
await Bun.write(`${OUT}/toast.png`, Buffer.from(shot.result.data, "base64"));
console.log("saved toast.png");
ws.close();
process.exit(0);
