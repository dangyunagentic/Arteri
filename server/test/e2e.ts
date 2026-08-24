// Arteri E2E: boots the real server + a mock upstream, then drives the full pipeline:
// login -> provider -> models (thinking spans) -> key with 1B limit + share link ->
// non-stream & stream calls, usage metering, limit block, thinking clamp, /v1/models.

let failures = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// ---- boot mock upstream
const mock = Bun.spawn(["bun", "run", "test/mock-upstream.ts"], { cwd: import.meta.dir + "/.." });
await new Promise((r) => setTimeout(r, 800));

// ---- boot arteri (fresh DB) — env MUST be set before any src import touches db.ts
process.env.PORT = "8799";
process.env.DATA_DIR = import.meta.dir + "/../.e2e-data";
process.env.ADMIN_PASSWORD = "e2e-pass-1";
const { default: app } = await import("../src/index");
const { db } = await import("../src/db");
const BASE = "http://127.0.0.1:8799";
Bun.serve({ port: 8799, fetch: app.fetch, idleTimeout: 120 });
await new Promise((r) => setTimeout(r, 300));

async function api(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, init);
  let j: any = null;
  try {
    j = await res.json();
  } catch {}
  return { status: res.status, json: j, res };
}

console.log("\n== auth ==");
const badLogin = await api("/api/admin/login", {
  method: "POST",
  body: JSON.stringify({ password: "wrong" }),
});
ok(badLogin.status === 400 || badLogin.status === 429, "wrong password rejected");

// get session cookie
const loginRes = await fetch(BASE + "/api/admin/login", {
  method: "POST",
  body: JSON.stringify({ password: "e2e-pass-1" }),
});
ok(loginRes.status === 200, "login ok");
const cookie = (loginRes.headers.getSetCookie?.() ?? [])
  .map((s) => s.split(";")[0])
  .join("; ");
const H = { cookie, "content-type": "application/json" };

console.log("\n== provider ==");
const prov = await api("/api/admin/providers", {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    name: "MockAI",
    base_url: "http://localhost:9991/v1",
    api_key: "sk-mock-123",
    protocol: "openai",
  }),
});
ok(prov.status === 201, "provider created");
const provId = prov.json.id;

console.log("\n== models with thinking spans ==");
async function addModel(publicId: string, upstream: string, sup: boolean, min: number, max: number) {
  const r = await api("/api/admin/models", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      provider_id: provId,
      public_id: publicId,
      upstream_id: upstream,
      thinking_supported: sup,
      min_thinking: min,
      max_thinking: max,
      enabled: true,
    }),
  });
  ok(r.status === 201, `model ${publicId}`);
}
await addModel("mock/mini", "gpt-5.2-mini", false, 0, 0);
await addModel("mock/main", "gpt-5.2", true, 1024, 65536);

const discover = await api(`/api/admin/providers/${provId}/models`, { headers: H });
ok(Array.isArray(discover.json.ids) && discover.json.ids.includes("claude-sonnet-thinking"), "model discovery lists upstream ids");

console.log("\n== key with 1B budget + share ==");
const keyRes = await api("/api/admin/keys", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ label: "public", limit_total: 1_000_000_000 }),
});
ok(keyRes.status === 201, "key created");
const KEY = keyRes.json.token;
const keyId = keyRes.json.id;

const shareRes = await api(`/api/admin/keys/${keyId}/share`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ enable: true }),
});
ok(!!shareRes.json.share_slug, "share slug minted");
const SLUG = shareRes.json.share_slug;

console.log("\n== inference: auth & limits ==");
const noKey = await api("/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mock/main", messages: [{ role: "user", content: "x" }] }),
});
ok(noKey.status === 401, "missing key -> 401");

const badModel = await api("/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "nope/model", messages: [] }),
});
ok(badModel.status === 404, "unknown model -> 404");

console.log("\n== inference: non-stream + usage metering ==");
const r1 = await api("/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "mock/main", messages: [{ role: "user", content: "hi" }] }),
});
ok(r1.status === 200 && r1.json.choices?.[0]?.message?.content === "openai says hi", "non-stream openai relayed");
ok(r1.res.headers.get("x-arteri-latency-ms") !== null, "latency header present");

let k = (await api("/api/admin/keys", { headers: H })).json.find((x: any) => x.id === keyId);
ok(k.used_total === 30, "usage counted (10+20)", `got ${k.used_total}`);

console.log("\n== thinking engine ==");
// effort high on a thinking model: vendor knob passes through, model translated
const r2 = await api("/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "mock/main",
    messages: [],
    reasoning_effort: "high",
  }),
});
let bodies = await mockBodies();
const sentHigh = bodies.find((b) => b.model === "gpt-5.2" && b.reasoning_effort === "high");
ok(
  !!sentHigh,
  "effort passed as vendor knob, model translated",
  JSON.stringify(bodies.at(-1))
);

// unsupported model strips the knob entirely
await api("/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "mock/mini", messages: [], reasoning_effort: "high" }),
});
bodies = await mockBodies();
const sentMini = bodies.at(-1)!;
ok(
  sentMini.model === "gpt-5.2-mini" &&
    sentMini.reasoning_effort === undefined &&
    !("reasoning" in sentMini) &&
    !("thinking" in sentMini),
  "unsupported model strips thinking fields"
);

// no ask -> untouched pass-through (no silent default burn)
await api("/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "mock/main", messages: [] }),
});
bodies = await mockBodies();
ok(
  bodies.at(-1)!.reasoning_effort === undefined,
  "no client ask -> no injected thinking"
);

console.log("\n== streaming + tap ==");
const streamRes = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "mock/main", messages: [], stream: true }),
});
ok(
  streamRes.headers.get("content-type").includes("event-stream"),
  "stream content-type passthrough"
);
const streamText = await streamRes.text();
ok(streamText.includes("[DONE]") && streamText.includes('"he"'), "SSE chunks intact");
await new Promise((r) => setTimeout(r, 300));
k = (await api("/api/admin/keys", { headers: H })).json.find((x: any) => x.id === keyId);
// 30 (r1) + 30*3 (thinking section calls) + 33 (stream tap 11+22)
ok(k.used_total === 153, "stream usage tapped via flush", `got ${k.used_total}`);

console.log("\n== anthropic surface (/v1/messages alias) ==");
const am = await api("/v1/messages", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "mock/main", messages: [], max_tokens: 100 }),
});
// openai-protocol upstream -> openai-shaped response relays through the anthropic-style route
ok(am.status === 200 && am.json.choices?.[0]?.message?.content === "openai says hi", "/v1/messages accepted and relayed");
await new Promise((r) => setTimeout(r, 200));
k = (await api("/api/admin/keys", { headers: H })).json.find((x: any) => x.id === keyId);
ok(k.used_total === 183, "alias call metered too", `got ${k.used_total}`);

console.log("\n== /v1/models for key ==");
const ml = await api("/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
ok(ml.json.data.length === 2 && ml.json.data[0].thinking !== undefined, "models listed with thinking metadata");

console.log("\n== share page (public, no auth) ==");
const sh = await api(`/api/share/${SLUG}`);
ok(sh.status === 200 && sh.json.api_key === KEY, "share exposes base url + api key");
ok(sh.json.limit_total === 1_000_000_000 && sh.json.pct_used > 0, "share shows budget % used", String(sh.json.pct_used));
const sh404 = await api("/api/share/nope");
ok(sh404.status === 404, "bad slug -> 404");

console.log("\n== token limit block ==");
db.query("UPDATE keys SET limit_total=50 WHERE id=?").run(keyId); // exhaust it
const blocked = await api("/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "mock/main", messages: [] }),
});
ok(blocked.status === 429 && blocked.json.error.code === "token_limit_reached", "exhausted key -> 429");

console.log("\n== rpm cap ==");
const rk = await api("/api/admin/keys", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ label: "rpm-test", rpm: 2 }),
});
const RKEY = rk.json.token;
for (let i = 0; i < 3; i++) {
  var last = await api("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${RKEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/mini", messages: [] }),
  });
}
ok(last.status === 429 && last.json.error.code === "rate_limited", "3rd request in a minute -> 429");

// helper: read bodies the mock upstream received
async function mockBodies(): Promise<any[]> {
  const r = await fetch("http://localhost:9991/_bodies");
  return r.json();
}
function lastBody(): any {
  return (globalThis as any).__lastBody ?? {};
}

console.log(failures === 0 ? "\nALL E2E PASSED" : `\n${failures} FAILURES`);
mock.kill();
process.exit(failures === 0 ? 0 : 1);
