// Console control-plane: auth + CRUD for providers/models/keys + usage reads.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db, getSetting, setSetting } from "./db";
import { BadRequest, parseJson, str, optStr, intOrNull, bool } from "./validate";
import type { Context, Handler } from "hono";
import { CATALOG, catalogGet } from "./catalog";
import { getSaversConfig, setSaversConfig } from "./savers-config";
import { OAUTH_CATALOG, catalogAny } from "./catalog";
import { startOAuth, exchangeCode, parseBulkTokens } from "./oauth";

export const admin = new Hono();

// ---------- auth ----------

function secret(): string {
  let s = getSetting("console_secret");
  if (!s) {
    s = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    setSetting("console_secret", s);
  }
  return s;
}

function sessionToken(): string {
  return Bun.SHA256.hash(secret() + ":admin-session", "hex") as unknown as string;
}
const sleepIfFail = () => new Promise((r) => setTimeout(r, 400));

const loginAttempts = new Map<string, { n: number; ts: number }>();
function ipOf(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "local"
  );
}

export function isAdmin(c: Context): boolean {
  const key = c.req.header("x-admin-key");
  const envKey = process.env.ADMIN_API_KEY?.trim();
  if (envKey && key && timingSafeEq(key, envKey)) return true;
  return getCookie(c, "arteri_admin") === sessionToken();
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function ensurePassword() {
  let p = getSetting("admin_password_hash");
  const envPw = process.env.ADMIN_PASSWORD?.trim();
  if (envPw) {
    // env always wins so docker users can rotate it
    const h = await Bun.password.hash(envPw);
    if (p !== h) setSetting("admin_password_hash", h);
    return;
  }
  if (!p) {
    const generated = "arteri-" + crypto.randomUUID().slice(0, 8);
    setSetting("admin_password_hash", await Bun.password.hash(generated));
    setSetting("admin_password_generated", generated);
    console.log("\n┌─────────────────────────────────────────────┐");
    console.log("│ Arteri console password (shown once):       │");
    console.log(`│   ${generated.padEnd(43)}│`);
    console.log("└─────────────────────────────────────────────┘\n");
  }
}

export const requireAdmin: Handler = async (c, next) => {
  if (!isAdmin(c)) return c.json({ error: { code: "unauthorized", message: "admin only" } }, 401);
  await next();
};

admin.post("/login", async (c) => {
  await ensurePassword();
  const ip = ipOf(c);
  const att = loginAttempts.get(ip);
  if (att && Date.now() - att.ts < 60_000 && att.n >= 10)
    return c.json({ error: { code: "rate_limited", message: "too many attempts" } }, 429);
  const body = await parseJson(c);
  const pw = typeof body.password === "string" ? body.password : "";
  const hash = getSetting("admin_password_hash");
  const ok = hash ? await Bun.password.verify(pw, hash) : false;
  if (!ok) {
    const cur = loginAttempts.get(ip);
    loginAttempts.set(ip, { n: (cur && Date.now() - cur.ts < 60_000 ? cur.n : 0) + 1, ts: Date.now() });
    await sleepIfFail();
    throw new BadRequest("wrong password");
  }
  loginAttempts.delete(ip);
  setCookie(c, "arteri_admin", sessionToken(), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

admin.post("/logout", (c) => {
  deleteCookie(c, "arteri_admin", { path: "/" });
  return c.json({ ok: true });
});

admin.get("/session", (c) => c.json({ authenticated: isAdmin(c) }));

admin.use("*", requireAdmin); // guard everything below (mounted under /api/admin)

// ---------- overview ----------

admin.get("/overview", (c) => {
  const dayStart = Date.now() - 24 * 3600_000;
  const one = (q: string, ...a: any[]) =>
    (db.query(q).get(...a) as any) ?? {};
  const totals = one(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens,
            COALESCE(SUM(reasoning_tokens),0) AS reasoning
     FROM usage`
  );
  const today = one(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens
     FROM usage WHERE ts > ?`,
    dayStart
  );
  const counts = {
    providers: (one(`SELECT COUNT(*) AS n FROM providers`).n ?? 0) as number,
    models: (one(`SELECT COUNT(*) AS n FROM models WHERE enabled=1`).n ?? 0) as number,
    keys: (one(`SELECT COUNT(*) AS n FROM keys`).n ?? 0) as number,
  };
  const topModels = db
    .query(
      `SELECT model, COUNT(*) AS requests, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens
       FROM usage GROUP BY model ORDER BY tokens DESC LIMIT 8`
    )
    .all();
  const recent = db
    .query(
      `SELECT u.id, u.model, u.prompt_tokens, u.completion_tokens, u.reasoning_tokens,
              u.status, u.ts, k.label AS key_label
       FROM usage u LEFT JOIN keys k ON k.id = u.key_id
       ORDER BY u.id DESC LIMIT 20`
    )
    .all();
  const uptime = Math.floor(process.uptime());
  const mem = process.memoryUsage.rss();
  return c.json({ totals, today, counts, topModels, recent, uptime, rss: mem });
});

// ---------- providers ----------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

admin.get("/providers", (c) => {
  const rows = db
    .query("SELECT id, slug, name, catalog, base_url, protocol, extra_headers, created_at, auth_type, email FROM providers ORDER BY id")
    .all();
  const counts = db.query("SELECT provider_id, COUNT(*) AS n FROM models GROUP BY provider_id").all() as any[];
  const map = new Map(counts.map((r) => [r.provider_id, r.n]));
  // mask api_key presence only
  const withKeys = db.query("SELECT id, length(api_key) AS has FROM providers").all() as any[];
  const hasMap = new Map(withKeys.map((r) => [r.id, r.has > 0]));
  return c.json(rows.map((r: any) => ({ ...r, model_count: map.get(r.id) ?? 0, has_key: hasMap.get(r.id) ?? false })));
});

admin.post("/providers", async (c) => {
  const b = await parseJson(c);
  const name = str(b.name, "name", 80);
  const baseUrl = str(b.base_url, "base_url", 500);
  if (!/^https?:\/\//.test(baseUrl)) throw new BadRequest("base_url must start with http(s)://");
  const slug =
    (optStr(b.slug, 60) ??
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40)) ||
    "p-" + Date.now().toString(36);
  if (!SLUG_RE.test(slug)) throw new BadRequest("slug must be [a-z0-9-]");
  const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
  const protocol = b.protocol === "anthropic" ? "anthropic" : "openai";
  let extra = "{}";
  if (b.extra_headers !== undefined) {
    if (typeof b.extra_headers !== "object" || Array.isArray(b.extra_headers))
      throw new BadRequest("extra_headers must be an object");
    extra = JSON.stringify(b.extra_headers);
  }
  const r = db
    .query(
      `INSERT INTO providers (slug, name, base_url, api_key, protocol, extra_headers, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(slug, name, baseUrl.replace(/\/+$/, ""), apiKey, protocol, extra, Date.now());
  return c.json({ id: Number(r.lastInsertRowid) }, 201);
});

admin.patch("/providers/:id", async (c) => {
  const id = intOrNull(c.req.param("id"), "id");
  const row = db.query("SELECT * FROM providers WHERE id=?").get(id) as any;
  if (!row) return c.json({ error: { code: "not_found", message: "no such provider" } }, 404);
  const b = await parseJson(c);
  const name = optStr(b.name, 80) ?? row.name;
  let baseUrl = row.base_url;
  if (b.base_url !== undefined) {
    baseUrl = str(b.base_url, "base_url", 500);
    if (!/^https?:\/\//.test(baseUrl)) throw new BadRequest("base_url must start with http(s)://");
    baseUrl = baseUrl.replace(/\/+$/, "");
  }
  const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : row.api_key;
  const protocol = b.protocol === "anthropic" ? "anthropic" : b.protocol === "openai" ? "openai" : row.protocol;
  let extra = row.extra_headers;
  if (b.extra_headers !== undefined) {
    if (typeof b.extra_headers !== "object" || Array.isArray(b.extra_headers))
      throw new BadRequest("extra_headers must be an object");
    extra = JSON.stringify(b.extra_headers);
  }
  db.query("UPDATE providers SET name=?, base_url=?, api_key=?, protocol=?, extra_headers=? WHERE id=?").run(
    name, baseUrl, apiKey, protocol, extra, id
  );
  return c.json({ ok: true });
});

admin.delete("/providers/:id", (c) => {
  db.query("DELETE FROM providers WHERE id=?").run(intOrNull(c.req.param("id"), "id"));
  return c.json({ ok: true });
});

/** Discover upstream models: GET {base}/v1/models (openai) — best effort list of ids. */
admin.get("/providers/:id/models", async (c) => {
  const p = db.query("SELECT * FROM providers WHERE id=?").get(intOrNull(c.req.param("id"), "id")) as any;
  if (!p) return c.json({ error: { code: "not_found", message: "no such provider" } }, 404);
  try {
    const res = await fetch(p.base_url.replace(/\/+$/, "") + "/models", {
      headers: { authorization: `Bearer ${p.api_key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => null);
    const ids = j?.data?.map((d: any) => d?.id).filter((x: any) => typeof x === "string") ?? [];
    return c.json({ ids });
  } catch (e: any) {
    return c.json({ ids: [], error: e?.message ?? "fetch failed" });
  }
});

// ---------- models ----------

admin.get("/models", (c) => {
  const rows = db
    .query(
      `SELECT m.*, p.name AS provider_name, p.slug AS provider_slug
       FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY m.sort, m.public_id`
    )
    .all();
  return c.json(rows);
});

interface ModelInput {
  provider_id: number;
  upstream_id: string;
  public_id: string;
  thinking_supported: boolean;
  min_thinking: number | null;
  max_thinking: number | null;
  enabled: boolean;
}

function parseModelInput(b: any, partialFrom?: any): ModelInput {
  const src = { ...(partialFrom ?? {}), ...b };
  const pid = intOrNull(src.provider_id, "provider_id");
  if (pid === null) throw new BadRequest("provider_id is required");
  return {
    provider_id: pid,
    upstream_id: str(src.upstream_id, "upstream_id", 200),
    public_id: str(src.public_id, "public_id", 200),
    thinking_supported: bool(src.thinking_supported),
    min_thinking: intOrNull(src.min_thinking, "min_thinking", 0, 1e7),
    max_thinking: intOrNull(src.max_thinking, "max_thinking", 0, 1e7),
    enabled: src.enabled === undefined ? true : bool(src.enabled),
  };
}

admin.post("/models", async (c) => {
  const m = parseModelInput(await parseJson(c));
  try {
    const r = db
      .query(
        `INSERT INTO models (provider_id, upstream_id, public_id, thinking_supported, min_thinking, max_thinking, enabled, sort)
         VALUES (?,?,?,?,?,?,?,0)`
      )
      .run(m.provider_id, m.upstream_id, m.public_id, m.thinking_supported ? 1 : 0, m.min_thinking ?? 0, m.max_thinking ?? 0, m.enabled ? 1 : 0);
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  } catch (e: any) {
    if (String(e?.message ?? "").includes("UNIQUE"))
      throw new BadRequest(`model '${m.public_id}' already exists`);
    throw e;
  }
});

admin.patch("/models/:id", async (c) => {
  const id = intOrNull(c.req.param("id"), "id");
  const row = db.query("SELECT * FROM models WHERE id=?").get(id) as any;
  if (!row) return c.json({ error: { code: "not_found", message: "no such model" } }, 404);
  const m = parseModelInput(await parseJson(c), row);
  try {
    db.query(
      `UPDATE models SET provider_id=?, upstream_id=?, public_id=?, thinking_supported=?, min_thinking=?, max_thinking=?, enabled=? WHERE id=?`
    ).run(m.provider_id, m.upstream_id, m.public_id, m.thinking_supported ? 1 : 0, m.min_thinking ?? 0, m.max_thinking ?? 0, m.enabled ? 1 : 0, id);
    return c.json({ ok: true });
  } catch (e: any) {
    if (String(e?.message ?? "").includes("UNIQUE"))
      throw new BadRequest(`model '${m.public_id}' already exists`);
    throw e;
  }
});

admin.delete("/models/:id", (c) => {
  db.query("DELETE FROM models WHERE id=?").run(intOrNull(c.req.param("id"), "id"));
  return c.json({ ok: true });
});

// ---------- keys ----------

function keyWithComputed(k: any) {
  const remaining = k.limit_total === null ? null : Math.max(0, k.limit_total - k.used_total);
  const pctUsed = k.limit_total ? Math.min(100, (k.used_total / k.limit_total) * 100) : 0;
  return { ...k, remaining, pct_used: pctUsed };
}

admin.get("/keys", (c) => {
  const rows = db.query("SELECT * FROM keys ORDER BY id DESC").all();
  return c.json(rows.map(keyWithComputed));
});

function genToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "sk-arteri-" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

admin.post("/keys", async (c) => {
  const b = await parseJson(c);
  const label = optStr(b.label, 80) ?? "";
  const limitTotal = intOrNull(b.limit_total, "limit_total", 1);
  const rpm = intOrNull(b.rpm, "rpm", 1, 100000);
  let allowed: string[] = [];
  if (b.allowed_models !== undefined && b.allowed_models !== null) {
    if (!Array.isArray(b.allowed_models)) throw new BadRequest("allowed_models must be an array");
    allowed = b.allowed_models.map((x: any) => String(x)).slice(0, 200);
  }
  const token = genToken();
  const r = db
    .query("INSERT INTO keys (token, label, enabled, limit_total, rpm, allowed_models, created_at) VALUES (?,?,1,?,?,?,?)")
    .run(token, label, limitTotal, rpm, JSON.stringify(allowed), Date.now());
  const row = db.query("SELECT * FROM keys WHERE id=?").get(r.lastInsertRowid);
  return c.json(keyWithComputed(row), 201);
});

admin.patch("/keys/:id", async (c) => {
  const id = intOrNull(c.req.param("id"), "id");
  const row = db.query("SELECT * FROM keys WHERE id=?").get(id) as any;
  if (!row) return c.json({ error: { code: "not_found", message: "no such key" } }, 404);
  const b = await parseJson(c);
  const label = optStr(b.label, 80) ?? row.label;
  const enabled = b.enabled === undefined ? !!row.enabled : bool(b.enabled);
  const limitTotal = b.limit_total === undefined ? row.limit_total : intOrNull(b.limit_total, "limit_total", 1);
  const rpm = b.rpm === undefined ? row.rpm : intOrNull(b.rpm, "rpm", 1, 100000);
  let allowed = row.allowed_models;
  if (b.allowed_models !== undefined && b.allowed_models !== null) {
    if (!Array.isArray(b.allowed_models)) throw new BadRequest("allowed_models must be an array");
    allowed = JSON.stringify(b.allowed_models.map((x: any) => String(x)).slice(0, 200));
  }
  db.query("UPDATE keys SET label=?, enabled=?, limit_total=?, rpm=?, allowed_models=? WHERE id=?").run(
    label, enabled ? 1 : 0, limitTotal, rpm, allowed, id
  );
  return c.json(keyWithComputed(db.query("SELECT * FROM keys WHERE id=?").get(id)));
});

admin.post("/keys/:id/rotate", (c) => {
  const id = intOrNull(c.req.param("id"), "id");
  const token = genToken();
  db.query("UPDATE keys SET token=? WHERE id=?").run(token, id);
  return c.json({ token });
});

admin.post("/keys/:id/reset-usage", (c) => {
  db.query("UPDATE keys SET used_total=0 WHERE id=?").run(intOrNull(c.req.param("id"), "id"));
  return c.json({ ok: true });
});

admin.delete("/keys/:id", (c) => {
  db.query("DELETE FROM keys WHERE id=?").run(intOrNull(c.req.param("id"), "id"));
  return c.json({ ok: true });
});

// ---------- share links ----------

admin.post("/keys/:id/share", async (c) => {
  const id = intOrNull(c.req.param("id"), "id");
  const row = db.query("SELECT * FROM keys WHERE id=?").get(id) as any;
  if (!row) return c.json({ error: { code: "not_found", message: "no such key" } }, 404);
  const body = await parseJson(c).catch(() => ({}) as any);
  const enable = body.enable === undefined ? !row.share_slug : bool(body.enable);
  if (!enable) {
    db.query("UPDATE keys SET share_slug=NULL WHERE id=?").run(id);
    return c.json({ share_slug: null });
  }
  let slug = row.share_slug;
  if (!slug) {
    slug = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    db.query("UPDATE keys SET share_slug=? WHERE id=?").run(slug, id);
  }
  return c.json({ share_slug: slug });
});

// ---------- OAuth providers (subscription accounts) ----------
// state -> { verifier, catalogId, redirectUri, createdAt } (in-memory, 10 min TTL)
const oauthPending = new Map<string, { verifier: string; catalogId: string; redirectUri: string; ts: number }>();

admin.get("/oauth/catalog", (c) =>
  c.json(
    OAUTH_CATALOG.map((e) => ({
      id: e.id,
      name: e.name,
      website: e.website ?? null,
      notice: e.notice ?? null,
      supports_bulk: e.id === "openai-codex",
      models: e.staticModels ?? [],
    }))
  )
);

// begin interactive oauth: returns the URL the admin opens in a browser
admin.post("/oauth/:catalog/start", async (c) => {
  const entry = catalogAny(c.req.param("catalog"));
  if (!entry?.oauth) throw new BadRequest("not an oauth provider");
  const redirectUri = `${process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || "http://localhost:8787"}/api/admin/oauth/${entry.id}/callback`;
  const started = startOAuth(entry, redirectUri);
  oauthPending.set(started.state, {
    verifier: started.verifier,
    catalogId: entry.id,
    redirectUri,
    ts: Date.now(),
  });
  // gc old entries
  for (const [k, v] of oauthPending) if (Date.now() - v.ts > 600_000) oauthPending.delete(k);
  return c.json({ authorize_url: started.url, state: started.state });
});

// browser hits this after consent — exchange code, store tokens on a new connection row
admin.get("/oauth/:catalog/callback", async (c) => {
  const entry = catalogAny(c.req.param("catalog"));
  if (!entry?.oauth) return c.text("unknown oauth provider", 400);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("missing code/state", 400);
  const pending = oauthPending.get(state);
  if (!pending) return c.text("expired or unknown state — restart the flow", 400);
  oauthPending.delete(state);
  const xchg = await exchangeCode(entry, code, pending.verifier, pending.redirectUri);
  if (!xchg.ok || !xchg.tokens)
    return c.text(`token exchange failed: ${xchg.error ?? "?"}`, 502);

  // create connection row for this account
  const n = (db.query("SELECT COUNT(*) AS n FROM providers WHERE catalog = ?").get(entry.id) as any).n;
  const slug = n === 0 ? entry.id : `${entry.id}-${n + 1}`;
  const r = db
    .query(
      `INSERT INTO providers (slug, name, catalog, base_url, api_key, protocol, extra_headers, created_at, auth_type, email, tokens)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      slug,
      entry.name + (n === 0 ? "" : ` ${n + 1}`),
      entry.id,
      entry.baseUrl,
      "", // no api key; bearer comes from tokens
      entry.protocol,
      JSON.stringify(entry.extraHeaders ?? {}),
      Date.now(),
      "oauth",
      xchg.email ?? "",
      JSON.stringify(xchg.tokens)
    );
  // seed model rows from static list (all enabled)
  const pid = Number(r.lastInsertRowid);
  const ins = db.query(
    `INSERT OR IGNORE INTO models (provider_id, upstream_id, public_id, thinking_supported, min_thinking, max_thinking, enabled, sort)
     VALUES (?,?,?,?,?,?,1,0)`
  );
  (entry.staticModels ?? []).forEach((m) =>
    ins.run(pid, m.id, `${slug}/${m.id}`, /opus|sonnet|thinking|o[1345]/i.test(m.id) ? 1 : 0, 1024, 65536)
  );
  return c.redirect(`/console/providers?connected=${encodeURIComponent(entry.id)}`);
});

// manual paste of the callback URL (same flow, headless-friendly)
admin.post("/oauth/:catalog/finish", async (c) => {
  const entry = catalogAny(c.req.param("catalog"));
  if (!entry?.oauth) throw new BadRequest("not an oauth provider");
  const b = await parseJson(c);
  const callbackUrl = str(b.callback_url, "callback_url", 2000);
  let u: URL;
  try {
    u = new URL(callbackUrl);
  } catch {
    throw new BadRequest("paste the full callback URL including ?code=...&state=...");
  }
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code || !state) throw new BadRequest("callback URL has no code/state");
  const pending = oauthPending.get(state);
  if (!pending) throw new BadRequest("expired or unknown state — restart the flow");
  oauthPending.delete(state);
  const xchg = await exchangeCode(entry, code, pending.verifier, pending.redirectUri);
  if (!xchg.ok || !xchg.tokens) throw new BadRequest(`token exchange failed: ${xchg.error ?? "?"}`);
  const n = (db.query("SELECT COUNT(*) AS n FROM providers WHERE catalog = ?").get(entry.id) as any).n;
  const slug = n === 0 ? entry.id : `${entry.id}-${n + 1}`;
  const r = db
    .query(
      `INSERT INTO providers (slug, name, catalog, base_url, api_key, protocol, extra_headers, created_at, auth_type, email, tokens)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      slug,
      entry.name + (n === 0 ? "" : ` ${n + 1}`),
      entry.id,
      entry.baseUrl,
      "",
      entry.protocol,
      JSON.stringify(entry.extraHeaders ?? {}),
      Date.now(),
      "oauth",
      xchg.email ?? "",
      JSON.stringify(xchg.tokens)
    );
  const pid = Number(r.lastInsertRowid);
  const ins = db.query(
    `INSERT OR IGNORE INTO models (provider_id, upstream_id, public_id, thinking_supported, min_thinking, max_thinking, enabled, sort)
     VALUES (?,?,?,?,?,?,1,0)`
  );
  (entry.staticModels ?? []).forEach((m) =>
    ins.run(pid, m.id, `${slug}/${m.id}`, /opus|sonnet|thinking|o[1345]/i.test(m.id) ? 1 : 0, 1024, 65536)
  );
  return c.json({ id: pid, slug, email: xchg.email ?? "" }, 201);
});

// bulk import token JSON (Codex CLI auth.json style)
admin.post("/oauth/:catalog/import", async (c) => {
  const entry = catalogAny(c.req.param("catalog"));
  if (!entry?.oauth) throw new BadRequest("not an oauth provider");
  const b = await parseJson(c);
  const raw = typeof b.json === "string" ? b.json : JSON.stringify(b.json);
  let items;
  try {
    items = parseBulkTokens(entry, raw);
  } catch {
    throw new BadRequest("invalid JSON — paste the contents of ~/.codex/auth.json or an array of accounts");
  }
  if (!items.length) throw new BadRequest("no usable accounts found (need accessToken/refreshToken)");
  const baseN = (db.query("SELECT COUNT(*) AS n FROM providers WHERE catalog = ?").get(entry.id) as any).n;
  const insP = db.query(
    `INSERT INTO providers (slug, name, catalog, base_url, api_key, protocol, extra_headers, created_at, auth_type, email, tokens)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insM = db.query(
    `INSERT OR IGNORE INTO models (provider_id, upstream_id, public_id, thinking_supported, min_thinking, max_thinking, enabled, sort)
     VALUES (?,?,?,?,?,?,1,0)`
  );
  let created = 0;
  items.forEach((item, idx) => {
    const seq = baseN + ++idx;
    const slug = seq === 1 && baseN === 0 ? entry.id : `${entry.id}-${seq}`;
    const r = insP.run(
      slug,
      entry.name + (baseN + idx === 1 ? "" : ` ${baseN + idx}`),
      entry.id,
      entry.baseUrl,
      "",
      entry.protocol,
      JSON.stringify(entry.extraHeaders ?? {}),
      Date.now(),
      "oauth",
      item.email ?? "",
      JSON.stringify(item.tokens)
    );
    const pid = Number(r.lastInsertRowid);
    (entry.staticModels ?? []).forEach((m) =>
      insM.run(pid, m.id, `${slug}/${m.id}`, /opus|sonnet|thinking|o[1345]/i.test(m.id) ? 1 : 0, 1024, 65536)
    );
    created++;
  });
  return c.json({ created }, 201);
});



admin.get("/catalog", (c) => {
  const connected = new Set(
    (db.query("SELECT slug FROM providers WHERE catalog != 'custom'").all() as any[]).map((r) => r.slug)
  );
  return c.json(
    CATALOG.map((e) => ({
      id: e.id,
      name: e.name,
      protocol: e.protocol,
      category: e.category,
      website: e.website ?? null,
      notice: e.notice ?? null,
      has_models_fetch: !!e.modelsUrl,
      connected_count: connected.has(e.id)
        ? (db.query("SELECT COUNT(*) AS n FROM providers WHERE slug = ?").get(e.id) as any).n
        : 0,
    }))
  );
});

// add a connection to a catalog provider (or a custom one with explicit base_url)
admin.post("/providers/connect", async (c) => {
  const b = await parseJson(c);
  const catalogId = optStr(b.catalog, 60) ?? "custom";
  let baseUrl: string;
  let name: string;
  let protocol: string;
  let extra = "{}";

  if (catalogId !== "custom") {
    const entry = catalogGet(catalogId);
    if (!entry) throw new BadRequest(`unknown catalog provider '${catalogId}'`);
    // multiple connections per catalog id -> slug-2, slug-3...
    const existing = db.query("SELECT COUNT(*) AS n FROM providers WHERE slug LIKE ?").all(catalogId + "%").length;
    const n = (db.query("SELECT COUNT(*) AS n FROM providers WHERE catalog = ?").get(catalogId) as any).n;
    void existing;
    const slug = n === 0 ? catalogId : `${catalogId}-${n + 1}`;
    name = optStr(b.name, 80) ?? entry.name + (n === 0 ? "" : ` ${n + 1}`);
    baseUrl = entry.baseUrl;
    protocol = entry.protocol;
    if (entry.extraHeaders) extra = JSON.stringify(entry.extraHeaders);
    const r = db
      .query(
        `INSERT INTO providers (slug, name, catalog, base_url, api_key, protocol, extra_headers, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(slug, name, catalogId, baseUrl, typeof b.api_key === "string" ? b.api_key.trim() : "", protocol, extra, Date.now());
    return c.json({ id: Number(r.lastInsertRowid), slug }, 201);
  }

  // custom connection — old behavior
  name = str(b.name, "name", 80);
  baseUrl = str(b.base_url, "base_url", 500);
  if (!/^https?:\/\//.test(baseUrl)) throw new BadRequest("base_url must start with http(s)://");
  const base =
    (optStr(b.slug, 60) ??
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40)) ||
    "p-" + Date.now().toString(36);
  if (!SLUG_RE.test(base)) throw new BadRequest("slug must be [a-z0-9-]");
  let slug = base;
  let n = 2;
  while (db.query("SELECT 1 FROM providers WHERE slug = ?").get(slug)) {
    slug = `${base}-${n++}`;
    if (n > 50) throw new BadRequest("could not derive a unique slug");
  }
  protocol = b.protocol === "anthropic" ? "anthropic" : "openai";
  if (b.extra_headers !== undefined) {
    if (typeof b.extra_headers !== "object" || Array.isArray(b.extra_headers))
      throw new BadRequest("extra_headers must be an object");
    extra = JSON.stringify(b.extra_headers);
  }
  const r = db
    .query(
      `INSERT INTO providers (slug, name, catalog, base_url, api_key, protocol, extra_headers, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(slug, name, "custom", baseUrl.replace(/\/+$/, ""), typeof b.api_key === "string" ? b.api_key.trim() : "", protocol, extra, Date.now());
  return c.json({ id: Number(r.lastInsertRowid), slug }, 201);
});

// fetch live models from the upstream and cache them (models_cache)
admin.post("/providers/:id/fetch-models", async (c) => {
  const p = db.query("SELECT * FROM providers WHERE id=?").get(intOrNull(c.req.param("id"), "id")) as any;
  if (!p) return c.json({ error: { code: "not_found", message: "no such provider" } }, 404);
  const entry = p.catalog && p.catalog !== "custom" ? catalogGet(p.catalog) : undefined;

  try {
    const url = entry?.modelsUrl ?? p.base_url.replace(/\/+$/, "") + "/models";
    const headers: Record<string, string> = {};
    if (p.api_key) {
      if (entry?.auth === "x-api-key") headers["x-api-key"] = p.api_key;
      else headers["authorization"] = `Bearer ${p.api_key}`;
    }
    for (const [k, v] of Object.entries(entry?.extraHeaders ?? {})) headers[k] = String(v);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok)
      return c.json({ error: { code: "fetch_failed", message: `upstream ${res.status}` } }, 502);
    const j: any = await res.json().catch(() => null);
    let models: { id: string; name: string }[] = [];
    const picker = entry?.modelsPicker ?? "openai";
    if (picker === "openrouter" || picker === "openai") {
      models = (j?.data ?? [])
        .filter((d: any) => typeof d?.id === "string")
        .map((d: any) => ({ id: d.id as string, name: String(d.name ?? d.id) }));
    } else if (picker === "gemini") {
      models = (j?.models ?? [])
        .filter((d: any) => typeof d?.name === "string")
        .map((d: any) => ({ id: (d.name as string).replace(/^models\//, ""), name: d.displayName ?? d.name }));
    } else {
      // bare array
      models = (Array.isArray(j) ? j : [])
        .filter((d: any) => typeof d?.id === "string")
        .map((d: any) => ({ id: d.id as string, name: String(d.name ?? d.id) }));
    }
    // keep only chat-ish models for together-style big lists
    if (picker === "together") {
      models = models.filter(
        (m: any) => !/embed|whisper|tts|rerank|guard|vision|diffusion|speech|bge-/i.test(m.id)
      );
    }
    const now = Date.now();
    db.query("DELETE FROM models_cache WHERE provider_id = ?").run(p.id);
    const ins = db.query(
      "INSERT OR IGNORE INTO models_cache (provider_id, upstream_id, display_name, fetched_at) VALUES (?,?,?,?)"
    );
    for (const m of models) ins.run(p.id, m.id, m.name.slice(0, 200), now);
    return c.json({ count: models.length });
  } catch (e: any) {
    return c.json({ error: { code: "fetch_failed", message: e?.message ?? "fetch failed" } }, 502);
  }
});

// list cached models of a connection
admin.get("/providers/:id/cached-models", (c) => {
  const pid = intOrNull(c.req.param("id"), "id");
  const rows = db
    .query("SELECT upstream_id, display_name FROM models_cache WHERE provider_id = ? ORDER BY upstream_id")
    .all(pid);
  const enabled = new Set(
    (db.query("SELECT upstream_id FROM models WHERE provider_id = ? AND enabled = 1").all(pid) as any[]).map((r) => r.upstream_id)
  );
  return c.json(rows.map((r: any) => ({ ...r, enabled: enabled.has(r.upstream_id) })));
});

// enable/disable a model row directly from the cache grid (auto-add on first toggle)
admin.post("/providers/:id/models/toggle", async (c) => {
  const pid = intOrNull(c.req.param("id"), "id");
  const p = db.query("SELECT * FROM providers WHERE id=?").get(pid) as any;
  if (!p) throw new BadRequest("no such provider");
  const b = await parseJson(c);
  const upstreamId = str(b.upstream_id, "upstream_id", 200);
  const enable = bool(b.enabled);
  const existing = db
    .query("SELECT id, enabled FROM models WHERE provider_id=? AND upstream_id=?")
    .get(pid, upstreamId) as any;
  if (existing) {
    db.query("UPDATE models SET enabled=? WHERE id=?").run(enable ? 1 : 0, existing.id);
    return c.json({ ok: true, id: existing.id });
  }
  if (!enable) return c.json({ ok: true }); // disabling a non-row is fine
  // auto-add: public_id = "<slug>/<upstream>" (9Router style), thinking heuristic by name
  const thinky = /thinking|reason|o[1345]|r1|qwq|deepseek/i.test(upstreamId);
  const publicId = `${p.slug}/${upstreamId}`;
  const r = db
    .query(
      `INSERT INTO models (provider_id, upstream_id, public_id, thinking_supported, min_thinking, max_thinking, enabled, sort)
       VALUES (?,?,?,?,?,?,1,0)`
    )
    .run(pid, upstreamId, publicId, thinky ? 1 : 0, thinky ? 1024 : 0, thinky ? 32768 : 0);
  return c.json({ ok: true, id: Number(r.lastInsertRowid) }, 201);
});

// test a connection: cheap auth'd GET to base_url/models
admin.post("/providers/:id/test", async (c) => {
  const p = db.query("SELECT * FROM providers WHERE id=?").get(intOrNull(c.req.param("id"), "id")) as any;
  if (!p) return c.json({ error: { code: "not_found", message: "no such provider" } }, 404);
  const entry = p.catalog && p.catalog !== "custom" ? catalogGet(p.catalog) : undefined;
  try {
    const url = entry?.modelsUrl ?? p.base_url.replace(/\/+$/, "") + "/models";
    const headers: Record<string, string> = {};
    if (p.api_key) {
      if (entry?.auth === "x-api-key") headers["x-api-key"] = p.api_key;
      else headers["authorization"] = `Bearer ${p.api_key}`;
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    return c.json({ ok: res.ok, status: res.status });
  } catch (e: any) {
    return c.json({ ok: false, status: 0, error: e?.message ?? "unreachable" });
  }
});

// ---------- combos ----------

admin.get("/combos", (c) => {
  const rows = db.query("SELECT * FROM combos ORDER BY id").all() as any[];
  const all = db.query("SELECT combo_id, position, target, weight FROM combo_models ORDER BY combo_id, position").all() as any[];
  const byCombo = new Map<number, any[]>();
  for (const cm of all) {
    if (!byCombo.has(cm.combo_id)) byCombo.set(cm.combo_id, []);
    byCombo.get(cm.combo_id)!.push(cm);
  }
  return c.json(rows.map((r) => ({ ...r, models: byCombo.get(r.id) ?? [] })));
});

const COMBO_TARGET_RE = /^[a-z0-9][a-z0-9-]{0,40}:[^\s:\/]+$/;

function validateComboTargets(targets: any[]) {
  if (!Array.isArray(targets) || targets.length === 0) throw new BadRequest("models must be a non-empty array");
  if (targets.length > 10) throw new BadRequest("max 10 models per combo");
  for (const t of targets) {
    if (typeof t !== "string" && typeof t?.target !== "string") throw new BadRequest("each model must be a target string");
    const s = typeof t === "string" ? t : t.target;
    if (!COMBO_TARGET_RE.test(s))
      throw new BadRequest(`combo target '${s}' must look like '<providerSlug>:<upstreamModelId>'`);
  }
}

admin.post("/combos", async (c) => {
  const b = await parseJson(c);
  const publicId = str(b.public_id, "public_id", 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,118}$/.test(publicId)) throw new BadRequest("invalid public_id");
  const strategy = b.strategy === "round_robin" || b.strategy === "weighted" ? b.strategy : "fallback";
  validateComboTargets(b.models);
  const r = db.query("INSERT INTO combos (public_id, strategy, enabled) VALUES (?,?,1)").run(publicId, strategy);
  const cid = Number(r.lastInsertRowid);
  const ins = db.query("INSERT INTO combo_models (combo_id, position, target, weight) VALUES (?,?,?,?)");
  (b.models as any[]).forEach((m, i) => {
    const target = typeof m === "string" ? m : m.target;
    const weight = typeof m === "object" && Number.isFinite(m.weight) ? Math.max(1, Math.min(10000, Math.round(m.weight))) : 100;
    ins.run(cid, i, target, weight);
  });
  return c.json({ id: cid }, 201);
});

admin.patch("/combos/:id", async (c) => {
  const id = intOrNull(c.req.param("id"), "id");
  const row = db.query("SELECT * FROM combos WHERE id=?").get(id) as any;
  if (!row) return c.json({ error: { code: "not_found", message: "no such combo" } }, 404);
  const b = await parseJson(c);
  const publicId = optStr(b.public_id, 120) ?? row.public_id;
  const strategy = b.strategy === "fallback" || b.strategy === "round_robin" || b.strategy === "weighted" ? b.strategy : row.strategy;
  const enabled = b.enabled === undefined ? !!row.enabled : bool(b.enabled);
  db.query("UPDATE combos SET public_id=?, strategy=?, enabled=? WHERE id=?").run(publicId, strategy, enabled ? 1 : 0, id);
  if (b.models !== undefined) {
    validateComboTargets(b.models);
    db.query("DELETE FROM combo_models WHERE combo_id=?").run(id);
    const ins = db.query("INSERT INTO combo_models (combo_id, position, target, weight) VALUES (?,?,?,?)");
    (b.models as any[]).forEach((m, i) => {
      const target = typeof m === "string" ? m : m.target;
      const weight = typeof m === "object" && Number.isFinite(m.weight) ? Math.max(1, Math.min(10000, Math.round(m.weight))) : 100;
      ins.run(id, i, target, weight);
    });
  }
  return c.json({ ok: true });
});

admin.delete("/combos/:id", (c) => {
  db.query("DELETE FROM combos WHERE id=?").run(intOrNull(c.req.param("id"), "id"));
  return c.json({ ok: true });
});

// ---------- quota tracker ----------
// Best-effort snapshots. Providers with usage APIs can be filled by /refresh;
// otherwise the dashboard tracks local consumption vs the key's own limit.

admin.get("/quota", (c) => {
  const rows = db
    .query(
      `SELECT q.connection_id, p.slug, p.name, p.catalog,
              q.window_kind, q.used, q.total, q.remaining, q.resets_at, q.fetched_at
       FROM quota q JOIN providers p ON p.id = q.connection_id
       ORDER BY p.name`
    )
    .all();
  return c.json(rows);
});

admin.post("/quota/refresh", async (c) => {
  // Anthropic supports an OAuth usage endpoint only; OpenAI-compatible providers don't
  // expose quota generically. Refresh what we can; everything else stays locally derived.
  const conns = db.query("SELECT * FROM providers WHERE catalog != 'custom'").all() as any[];
  let updated = 0;
  for (const p of conns) {
    const entry = catalogGet(p.catalog);
    if (!entry?.usageUrl || !p.api_key) continue;
    try {
      const headers: Record<string, string> = {};
      if (entry.auth === "x-api-key") headers["x-api-key"] = p.api_key;
      else headers["authorization"] = `Bearer ${p.api_key}`;
      const res = await fetch(entry.usageUrl, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const j: any = await res.json().catch(() => null);
      if (!j) continue;
      const used = Number(j.used ?? j.current_usage ?? 0);
      const total = Number(j.limit ?? j.max_usage ?? 0);
      const resetsAt = Number(j.reset_at ?? j.reset_date ?? 0) * (String(j.reset_at ?? "").length <= 10 ? 1000 : 1);
      db.query(
        `INSERT INTO quota (connection_id, window_kind, used, total, remaining, resets_at, fetched_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(connection_id) DO UPDATE SET used=excluded.used, total=excluded.total,
           remaining=excluded.remaining, resets_at=excluded.resets_at, fetched_at=excluded.fetched_at`
      ).run(p.id, String(j.window_kind ?? ""), used || null, total || null, total ? Math.max(0, total - used) : null, resetsAt || null, Date.now());
      updated++;
    } catch {}
  }
  return c.json({ updated });
});

// ---------- token savers settings ----------

admin.get("/settings/savers", (c) => c.json(getSaversConfig()));

admin.patch("/settings/savers", async (c) => {
  const b = await parseJson(c);
  const allowedKeys = ["rtk", "headroom", "caveman", "ponytail"] as const;
  const next: any = {};
  for (const k of allowedKeys) {
    const v = (b as any)[k];
    if (v === undefined) continue;
    if (!["off", "lite", "full", "ultra"].includes(v)) throw new BadRequest(`${k} must be off|lite|full|ultra`);
    next[k] = v;
  }
  return c.json(setSaversConfig(next));
});



admin.get("/usage", (c) => {
  const days = Math.min(90, Math.max(1, intOrNull(c.req.query("days"), "days", 1) ?? 14));
  const keyId = intOrNull(c.req.query("key_id"), "key_id", 1);
  const since = Date.now() - days * 24 * 3600_000;
  const params: any[] = [since];
  let where = "u.ts > ?";
  if (keyId) {
    where += " AND u.key_id = ?";
    params.push(keyId);
  }
  const daily = db
    .query(
      `SELECT date(u.ts/1000,'unixepoch') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(u.prompt_tokens+u.completion_tokens),0) AS tokens,
              COALESCE(SUM(u.reasoning_tokens),0) AS reasoning
       FROM usage u WHERE ${where}
       GROUP BY day ORDER BY day`
    )
    .all(...params);
  const perModel = db
    .query(
      `SELECT u.model, COUNT(*) AS requests, COALESCE(SUM(u.prompt_tokens+u.completion_tokens),0) AS tokens
       FROM usage u WHERE ${where} GROUP BY u.model ORDER BY tokens DESC LIMIT 15`
    )
    .all(...params);
  const perProvider = db
    .query(
      `SELECT u.provider_slug, COUNT(*) AS requests, COALESCE(SUM(u.prompt_tokens+u.completion_tokens),0) AS tokens
       FROM usage u WHERE ${where} GROUP BY u.provider_slug ORDER BY tokens DESC`
    )
    .all(...params);
  const errors = db
    .query(`SELECT COUNT(*) AS n FROM usage u WHERE ${where} AND u.status >= 400`)
    .get(...params) as any;
  return c.json({ daily, perModel, perProvider, errors: errors.n ?? 0, days });
});
