// Proxy core: auth -> limits -> resolve (model|combo) -> translate -> stream -> meter.
// v2: combos, connection round-robin per provider, token savers pipeline.
import type { Context } from "hono";
import { db } from "./db";
import { BadRequest, parseJson, bool } from "./validate";
import { buildUpstreamThinking, stripClientThinking } from "./thinking";
import { applySavers } from "./savers-apply";
import { getSaversConfig } from "./savers-config";

export interface KeyRow {
  id: number;
  token: string;
  label: string;
  enabled: number;
  limit_total: number | null;
  used_total: number;
  rpm: number | null;
  allowed_models: string;
}

export interface ModelRow {
  id: number;
  provider_id: number;
  upstream_id: string;
  public_id: string;
  thinking_supported: number;
  min_thinking: number;
  max_thinking: number;
  enabled: number;
  base_url: string;
  api_key: string;
  protocol: "openai" | "anthropic";
  extra_headers: string;
}

export function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const x = c.req.header("x-api-key");
  if (x) return x.trim();
  return null;
}

export function findKey(token: string): KeyRow | null {
  return db.query("SELECT * FROM keys WHERE token = ?").get(token) as KeyRow | null;
}

function rpmCount(keyId: number): number {
  const since = Date.now() - 60_000;
  const r = db
    .query("SELECT COUNT(*) AS n FROM usage WHERE key_id = ? AND ts > ?")
    .get(keyId, since) as { n: number };
  return r.n;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** Pre-flight: authenticate + authorize + rate-limit. Throws HttpError. */
export function gate(token: string | null, modelId: string | undefined) {
  if (!token) throw new HttpError(401, "missing_api_key", "Send Authorization: Bearer sk-arteri-...");
  const key = findKey(token);
  if (!key || !key.enabled)
    throw new HttpError(401, "invalid_api_key", "unknown or disabled key");
  if (key.limit_total !== null && key.used_total >= key.limit_total)
    throw new HttpError(
      429,
      "token_limit_reached",
      `key exhausted: ${key.used_total}/${key.limit_total} tokens used`
    );
  if (key.rpm !== null && rpmCount(key.id) >= key.rpm)
    throw new HttpError(429, "rate_limited", "requests-per-minute limit reached");
  if (!modelId) throw new HttpError(400, "missing_model", "body.model is required");
  const allowed = JSON.parse(key.allowed_models || "[]") as string[];
  if (allowed.length && !allowed.includes(modelId))
    throw new HttpError(403, "model_not_allowed", `model ${modelId} not allowed for this key`);
}

// ---- resolution -------------------------------------------------------------
export interface Resolved {
  kind: "model" | "combo";
  publicId: string;
  // for kind=model:
  model?: ModelRow;
  // for kind=combo:
  comboId?: number;
  strategy?: "fallback" | "round_robin" | "weighted";
  targets?: { target: string; weight: number; position: number }[];
}

export function resolve(publicId: string): Resolved {
  const combo = db
    .query("SELECT * FROM combos WHERE public_id = ? AND enabled = 1")
    .get(publicId) as { id: number; strategy: Resolved["strategy"] } | undefined;
  if (combo) {
    const targets = db
      .query("SELECT target, weight, position FROM combo_models WHERE combo_id = ? ORDER BY position")
      .all(combo.id) as { target: string; weight: number; position: number }[];
    if (!targets.length) throw new HttpError(500, "empty_combo", `combo ${publicId} has no models`);
    return { kind: "combo", publicId, comboId: combo.id, strategy: combo.strategy, targets };
  }
  const row = db
    .query(
      `SELECT m.*, p.base_url, p.api_key, p.protocol, p.extra_headers
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE m.public_id = ? AND m.enabled = 1`
    )
    .get(publicId) as ModelRow | undefined;
  if (!row) throw new HttpError(404, "model_not_found", `no enabled model or combo '${publicId}'`);
  return { kind: "model", publicId, model: row };
}

/** Pick the next target of a combo. Mutates combos.rr_cursor for round_robin. */
export function comboPick(r: Resolved): { target: string } {
  if (r.kind !== "combo" || !r.targets) return { target: "" };
  if (r.strategy === "fallback") return { target: r.targets[0].target }; // fallback walk happens on failure
  if (r.strategy === "round_robin") {
    const cur = r.comboId!;
    const row = db.query("SELECT rr_cursor FROM combos WHERE id = ?").get(cur) as { rr_cursor: number };
    const idx = row.rr_cursor % r.targets.length;
    db.query("UPDATE combos SET rr_cursor = rr_cursor + 1 WHERE id = ?").run(cur);
    return { target: r.targets[idx].target };
  }
  // weighted: random by weight
  const total = r.targets.reduce((s, t) => s + Math.max(1, t.weight), 0);
  let x = Math.random() * total;
  for (const t of r.targets) {
    x -= Math.max(1, t.weight);
    if (x <= 0) return { target: t.target };
  }
  return { target: r.targets[r.targets.length - 1].target };
}

/** target string -> concrete ModelRow. "<providerSlug>:<upstreamId>" or "<comboId>". */
export function targetModel(target: string): ModelRow {
  const [slug, upstream] = target.split(":", 2);
  if (!upstream) throw new HttpError(500, "bad_combo_target", `combo target '${target}' malformed`);
  const row = db
    .query(
      `SELECT m.*, p.base_url, p.api_key, p.protocol, p.extra_headers
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE p.slug = ? AND m.upstream_id = ? AND m.enabled = 1`
    )
    .get(slug, upstream) as ModelRow | undefined;
  if (!row)
    throw new HttpError(404, "combo_target_missing", `combo target '${target}' has no enabled model row`);
  return row;
}

/** All enabled model rows for a provider slug (connection round-robin pool). */
export function providerPool(slug: string): ModelRow[] {
  return db
    .query(
      `SELECT m.*, p.base_url, p.api_key, p.protocol, p.extra_headers
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE p.slug = ? AND m.enabled = 1`
    )
    .all(slug) as unknown as ModelRow[];
}

/** Round-robin across connections of the same catalog provider (9Router-style). */
export function pickConnection(slug: string, wantUpstream: string): ModelRow {
  const pool = db
    .query(
      `SELECT m.*, p.base_url, p.api_key, p.protocol, p.extra_headers
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE p.slug = ? AND m.upstream_id = ? AND m.enabled = 1`
    )
    .all(slug, wantUpstream) as unknown as ModelRow[];
  if (!pool.length)
    throw new HttpError(404, "combo_target_missing", `no enabled '${wantUpstream}' on '${slug}'`);
  if (pool.length === 1) return pool[0];
  const row = db
    .query("SELECT COALESCE(MAX(id),0) AS id FROM providers WHERE slug = ?")
    .get(slug) as { id: number };
  void row;
  const cursor = db
    .query("SELECT rr_cursor FROM combos WHERE public_id = ?")
    .get(slug) as { rr_cursor: number } | undefined;
  // per-provider cursor lives in settings (no combos row for plain models)
  const key = `rr:${slug}`;
  const cur = Number((db.query("SELECT value FROM settings WHERE key = ?").get(key) as any)?.value ?? 0) || 0;
  const picked = pool[cur % pool.length];
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(cur + 1)
  );
  void cursor;
  return picked;
}

// ---- usage capture ----------------------------------------------------------
interface Usage {
  prompt: number;
  completion: number;
  reasoning: number;
}
function emptyUsage(): Usage {
  return { prompt: 0, completion: 0, reasoning: 0 };
}
function capture(u: Usage, j: any) {
  if (!j || typeof j !== "object") return;
  const v = j.usage ?? j;
  u.prompt += num(v.prompt_tokens ?? v.input_tokens);
  u.completion += num(v.completion_tokens ?? v.output_tokens);
  const det = v.completion_tokens_details;
  u.reasoning += num(v.reasoning_tokens) + num(det?.reasoning_tokens);
}
function num(x: any): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
}
function record(
  keyId: number | null,
  model: string,
  resolvedModel: string,
  providerSlug: string,
  u: Usage,
  status: number
) {
  db.query(
    `INSERT INTO usage (key_id, model, resolved_model, provider_slug, prompt_tokens, completion_tokens, reasoning_tokens, status, ts)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(keyId, model, resolvedModel, providerSlug, u.prompt, u.completion, u.reasoning, status, Date.now());
  if (keyId && (u.prompt || u.completion)) {
    db.query("UPDATE keys SET used_total = used_total + ? WHERE id = ?").run(
      u.prompt + u.completion,
      keyId
    );
  }
}

const HOP_BY_HOP = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-encoding",
  "upgrade",
]);

function baseOf(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Build upstream Request for a model row. */
function upstreamRequest(m: ModelRow, body: Record<string, any>, stream: boolean): Request {
  const t = buildUpstreamThinking(body, m, m.protocol);
  stripClientThinking(body);
  if (t.value) {
    if (m.protocol === "anthropic") {
      body.thinking = t.value;
      const b = t.value.budget_tokens as number;
      if (!body.max_tokens) body.max_tokens = b + 8192;
      else if (body.max_tokens < b + 1) body.max_tokens = b + 1024;
    } else {
      body.reasoning_effort = (t.value as any).effort ?? body.reasoning_effort;
    }
  }
  body.model = m.upstream_id;
  body.stream = stream;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (m.protocol === "anthropic") {
    headers["x-api-key"] = m.api_key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${m.api_key}`;
  }
  headers["accept"] = stream ? "text/event-stream" : "application/json";
  try {
    const extra = JSON.parse(m.extra_headers || "{}");
    for (const [k, v] of Object.entries(extra))
      if (typeof v === "string" && k.toLowerCase() !== "host") headers[k] = v;
  } catch {}

  const path = m.protocol === "anthropic" ? "/messages" : "/chat/completions";
  return new Request(baseOf(m.base_url) + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
}

/** POST /v1/chat/completions (+ /v1/messages alias). */
export async function handleChat(c: Context) {
  const started = Date.now();
  const body = (await parseJson(c)) as Record<string, any>;
  const token = bearer(c);
  const modelId = typeof body.model === "string" ? body.model.trim() : undefined;
  gate(token, modelId);
  const key = findKey(token!)!;
  const stream = bool(body.stream);

  // token savers run on the CLIENT-FACING body before any targeting
  applySavers(body, getSaversConfig());

  const r = resolve(modelId!);

  // ---- single model: connection round-robin within the same provider slug ----
  if (r.kind === "model") {
    const m = await serveModel(r.model!, body, stream);
    return finish(c, m, key, r.publicId, started);
  }

  // ---- combo ----
  const attemptOrder: string[] =
    r.strategy === "fallback"
      ? r.targets!.map((t) => t.target)
      : [comboPick(r).target];
  let lastErr: HttpError | null = null;
  for (const target of attemptOrder) {
    let m: ModelRow;
    try {
      const [slug, upstream] = target.split(":", 2);
      m = upstream ? pickConnection(slug, upstream) : targetModel(target);
    } catch (e) {
      lastErr = e as HttpError;
      continue; // missing model row -> try next in chain
    }
    try {
      const out = await tryUpstream(m, body, stream);
      if (out.ok) return finish(c, { res: out.res, m }, key, r.publicId, started);
      lastErr = new HttpError(out.status, "upstream_error", `upstream ${out.status} on ${target}`);
    } catch (e: any) {
      lastErr = new HttpError(502, "upstream_unreachable", `${target}: ${e?.message ?? e}`);
    }
  }
  record(key.id, r.publicId, "", "", emptyUsage(), lastErr?.status ?? 502);
  throw lastErr ?? new HttpError(502, "combo_exhausted", "all combo targets failed");
}

async function tryUpstream(
  m: ModelRow,
  body: Record<string, any>,
  stream: boolean
): Promise<{ ok: boolean; status: number; res: Response }> {
  const req = upstreamRequest(m, body, stream);
  let res: Response;
  try {
    res = await fetch(req);
  } catch (e: any) {
    throw new HttpError(502, "upstream_unreachable", `provider unreachable: ${e?.message ?? e}`);
  }
  if (!res.ok && stream) {
    // can't safely retry a streamed failure after headers; relay as-is
    return { ok: res.status >= 200 && res.status < 300, status: res.status, res };
  }
  return { ok: res.ok, status: res.status, res };
}

async function serveModel(
  m: ModelRow,
  body: Record<string, any>,
  stream: boolean
): Promise<{ res: Response; m: ModelRow }> {
  const out = await tryUpstream(m, body, stream);
  if (!out.ok && out.status >= 500) {
    // single-model path: no fallback available; relay the failure
    return { res: out.res, m };
  }
  return { res: out.res, m };
}

async function finish(
  c: Context,
  out: { res: Response; m: ModelRow },
  key: KeyRow,
  publicId: string,
  started: number
) {
  const { res, m } = out;
  const ct = res.headers.get("content-type") ?? "";
  const u = emptyUsage();

  if (!ct.includes("event-stream")) {
    const text = await res.text().catch(() => "");
    try {
      capture(u, JSON.parse(text));
    } catch {}
    record(key.id, publicId, m.upstream_id, providerSlugOf(m), u, res.status);
    const headers: Record<string, string> = {
      "content-type": ct || "application/json",
      "x-arteri-latency-ms": String(Date.now() - started),
    };
    return new Response(text, { status: res.status, headers });
  }

  // SSE pass-through with usage tap
  const dec = new TextDecoder();
  let buf = "";
  const tapped = res.body!.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const data = s.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            capture(u, j);
            if (j?.type === "message_delta" && j.usage) capture(u, { usage: j.usage });
          } catch {}
        }
        ctrl.enqueue(chunk);
      },
      flush() {
        record(key.id, publicId, m.upstream_id, providerSlugOf(m), u, res.status);
      },
    })
  );
  return new Response(tapped, {
    status: res.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-arteri-latency-ms": String(Date.now() - started),
    },
  });
}

function providerSlugOf(m: ModelRow): string {
  const r = db.query("SELECT slug FROM providers WHERE id = ?").get(m.provider_id) as
    | { slug: string }
    | undefined;
  return r?.slug ?? "";
}

/** GET /v1/models for a key. */
export async function handleModels(c: Context) {
  const token = bearer(c);
  const key = token ? findKey(token) : null;
  if (!key || !key.enabled)
    return c.json({ error: { code: "invalid_api_key", message: "unknown or disabled key" } }, 401);
  const allowed = JSON.parse(key.allowed_models || "[]") as string[];
  let rows = db
    .query(
      `SELECT m.public_id, m.thinking_supported, m.min_thinking, m.max_thinking, p.name AS owner
       FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.enabled = 1 ORDER BY m.sort, m.public_id`
    )
    .all() as any[];
  const comboRows = db
    .query("SELECT public_id FROM combos WHERE enabled = 1")
    .all() as { public_id: string }[];
  let data = [
    ...rows.map((r) => ({
      id: r.public_id,
      object: "model",
      owned_by: r.owner,
      thinking: r.thinking_supported
        ? { supported: true, min_budget: r.min_thinking, max_budget: r.max_thinking }
        : { supported: false },
    })),
    ...comboRows.map((k) => ({ id: k.public_id, object: "model", owned_by: "combo", thinking: { supported: false } })),
  ];
  if (allowed.length) data = data.filter((d) => allowed.includes(d.id));
  return c.json({ object: "list", data });
}
