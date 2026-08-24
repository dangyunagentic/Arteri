// Arteri v2 E2E additions: catalog, connect, fetch-models, model toggle,
// combos (fallback + round-robin), token savers pipeline.
// Boots its own server + mock upstream (fresh DB).
import { mockBodies } from "./e2e-helpers";

const mock = Bun.spawn(["bun", "run", "test/mock-upstream.ts"], { cwd: import.meta.dir + "/.." });
await new Promise((r) => setTimeout(r, 800));
process.env.PORT = "8799";
process.env.DATA_DIR = import.meta.dir + "/../.e2e-data";
process.env.ADMIN_PASSWORD = "e2e-pass-1";
const { default: app } = await import("../src/index");

const BASE = "http://127.0.0.1:8799";
Bun.serve({ port: 8799, fetch: app.fetch, idleTimeout: 120 });
await new Promise((r) => setTimeout(r, 300));
let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

let cookie = "";
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
    redirect: "manual",
  });
  const sc = res.headers.get("set-cookie");
  if (sc && path === "/api/admin/login") cookie = sc.split(";")[0];
  return res;
}
async function j<T = any>(p: Promise<Response>): Promise<T> {
  return (await p).json() as Promise<T>;
}

console.log("\n== v2: catalog & connections ==");
await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: "e2e-pass-1" }) });
const catalog = await j<any[]>(api("/api/admin/catalog"));
ok(Array.isArray(catalog) && catalog.length >= 10, `catalog has ${catalog.length} providers`);
const orEntry = catalog.find((c) => c.id === "openrouter");
ok(!!orEntry && orEntry.has_models_fetch, "openrouter entry has models fetch");

const conn = await j<{ id: number; slug: string }>(
  api("/api/admin/providers/connect", {
    method: "POST",
    body: JSON.stringify({ catalog: "custom", name: "MockUp", base_url: "http://localhost:9991/v1", api_key: "mk-1" }),
  })
);
ok(conn.slug === "mockup" || !!conn.id, `custom connection created slug=${conn.slug}`);

// second connection to same custom provider -> slug collision avoided
const conn2 = await j<{ id: number; slug: string }>(
  api("/api/admin/providers/connect", {
    method: "POST",
    body: JSON.stringify({ catalog: "custom", name: "MockUp", base_url: "http://localhost:9992/v1", api_key: "" }),
  })
);
ok(conn2.slug !== conn.slug, `second connection gets unique slug=${conn2.slug}`);

console.log("\n== v2: fetch-models from upstream ==");
const fm = await j<{ count?: number }>(api(`/api/admin/providers/${conn.id}/fetch-models`, { method: "POST" }));
ok(typeof fm.count === "number" && fm.count >= 3, `fetched ${fm.count} models from mock upstream`);
const cached = await j<any[]>(api(`/api/admin/providers/${conn.id}/cached-models`));
const targetModel = cached.find((m) => m.upstream_id === "gpt-test") ?? cached[0];
ok(cached.length > 0 && !!targetModel, "cache lists fetched models");

console.log("\n== v2: enable model via toggle grid ==");
await j(api(`/api/admin/providers/${conn.id}/models/toggle`, {
  method: "POST",
  body: JSON.stringify({ upstream_id: targetModel.upstream_id, enabled: true }),
}));
const provModels = await j<any[]>(api("/api/admin/models"));
const row = provModels.find(
  (m) => m.provider_id === conn.id && m.upstream_id === targetModel.upstream_id
);
ok(!!row && row.public_id === `${conn.slug}/${targetModel.upstream_id}`, `toggle auto-added public_id=${row?.public_id}`);

console.log("\n== v2: token savers settings ==");
const sav0 = await j<SaversCfg>(api("/api/admin/settings/savers"));
ok(sav0.ponytail === "full", `default ponytail=full (got ${sav0.ponytail})`);
await j(api("/api/admin/settings/savers", { method: "PATCH", body: JSON.stringify({ rtk: "full", caveman: "lite", ponytail: "off" }) }));
const sav1 = await j<any>(api("/api/admin/settings/savers"));
ok(sav1.rtk === "full" && sav1.caveman === "lite" && sav1.ponytail === "off", "savers PATCH persists");

console.log("\n== v2: savers applied on proxied request ==");
// create key
const keyRes = await j<{ token: string }>(api("/api/admin/keys", { method: "POST", body: JSON.stringify({ label: "v2" }) }));
const chat = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${keyRes.token}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: row!.public_id,
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "t1", content: "x\n".repeat(300) },
      { role: "tool", tool_call_id: "t2", content: "y\n".repeat(300) },
      { role: "user", content: "again" },
    ],
  }),
});
ok(chat.status === 200, `proxied chat with savers -> ${chat.status}`);
const bodiesAll = await mockBodies();
const sentBody = bodiesAll[bodiesAll.length - 1];
const sysMsg = (sentBody.messages ?? []).find((m: any) => m.role === "system");
ok(!!sysMsg && /caveman|terse/i.test(sysMsg.content ?? ""), "caveman system prompt injected");
ok(!sentBody.reasoning_effort || typeof sentBody.reasoning_effort === "string", "no stray thinking knob");

console.log("\n== v2: combos ==");
// second model for the chain
await j(api(`/api/admin/providers/${conn.id}/models/toggle`, {
  method: "POST",
  body: JSON.stringify({ upstream_id: cached[1].upstream_id, enabled: true }),
}));
const comboRes = await api("/api/admin/combos", {
  method: "POST",
  body: JSON.stringify({
    public_id: "test-combo",
    strategy: "round_robin",
    models: [`${conn.slug}:${cached[0].upstream_id}`, `${conn.slug}:${cached[1].upstream_id}`],
  }),
});
ok(comboRes.status === 201, `combo created (${comboRes.status})`);
const badCombo = await api("/api/admin/combos", {
  method: "POST",
  body: JSON.stringify({ public_id: "bad", strategy: "fallback", models: ["not-a-target"] }),
});
ok(badCombo.status === 400, `malformed combo target rejected (${badCombo.status})`);

// round-robin across two calls
for (const t of [keyRes.token]) void t;
const call = () =>
  fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${keyRes.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test-combo", messages: [{ role: "user", content: "ping" }] }),
  });
const r1 = await call();
const r2 = await call();
ok(r1.status === 200 && r2.status === 200, `combo calls ok (${r1.status}/${r2.status})`);
await mockBodies();
const bodies = await mockBodies();
const lastTwo = bodies.slice(-2).map((b: any) => b.model);
ok(lastTwo[0] !== lastTwo[1], `round-robin alternated: ${lastTwo.join(" -> ")}`);

console.log(`\nv2 RESULT: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

interface SaversCfg {
  rtk: string;
  headroom: string;
  caveman: string;
  ponytail: string;
}
