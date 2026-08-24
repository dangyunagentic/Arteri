// Console control-plane: auth + CRUD for providers/models/keys + usage reads.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db, getSetting, setSetting } from "./db";
import { BadRequest, parseJson, str, optStr, intOrNull, bool } from "./validate";
import type { Context, Handler } from "hono";

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
  const rows = db.query("SELECT id, slug, name, base_url, protocol, extra_headers, created_at FROM providers ORDER BY id").all();
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

// ---------- usage series ----------

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
  const errors = db
    .query(`SELECT COUNT(*) AS n FROM usage u WHERE ${where} AND u.status >= 400`)
    .get(...params) as any;
  return c.json({ daily, perModel, errors: errors.n ?? 0, days });
});
