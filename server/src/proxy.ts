// Proxy core: auth -> limits -> resolve -> translate -> stream -> meter.
// The happy path reads top-to-bottom; every early return is an E break point.
import type { Context } from "hono";
import { db } from "./db";
import { BadRequest } from "./validate";
import { buildUpstreamThinking, stripClientThinking } from "./thinking";
import { parseJson, bool } from "./validate";

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
  if (!token) throw new HttpError(401, "missing_api_key", "Send Authorization: Bearer <key>");
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

export function resolveModel(publicId: string): ModelRow {
  const row = db
    .query(
      `SELECT m.*, p.base_url, p.api_key, p.protocol, p.extra_headers
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE m.public_id = ? AND m.enabled = 1`
    )
    .get(publicId) as ModelRow | undefined;
  if (!row) throw new HttpError(404, "model_not_found", `no enabled model '${publicId}'`);
  return row;
}

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
  const det = v.completion_tokens_details ?? v.cache_creation_input_tokens;
  u.reasoning += num(v.reasoning_tokens) + (typeof det === "number" ? 0 : num(det?.reasoning_tokens));
}
function num(x: any): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
}
function record(keyId: number | null, model: string, u: Usage, status: number) {
  if (!u.prompt && !u.completion && status >= 400) {
    // still log the failed attempt without inflating counters
  }
  db.query(
    `INSERT INTO usage (key_id, model, prompt_tokens, completion_tokens, reasoning_tokens, status, ts)
     VALUES (?,?,?,?,?,?,?)`
  ).run(keyId, model, u.prompt, u.completion, u.reasoning, status, Date.now());
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

/** Build upstream Request for chat-style completions. */
function upstreamRequest(m: ModelRow, body: Record<string, any>, stream: boolean): Request {
  // translate thinking knobs for this model/dialect
  const t = buildUpstreamThinking(body, m, m.protocol);
  stripClientThinking(body);
  if (t.value) {
    if (m.protocol === "anthropic") {
      body.thinking = t.value;
      const b = t.value.budget_tokens as number;
      if (!body.max_tokens) body.max_tokens = b + 8192;
      else if (body.max_tokens < b + 1) body.max_tokens = b + 1024;
    } else {
      // keep vendor-native single knob for chat completions
      body.reasoning_effort = (t.value as any).effort ?? body.reasoning_effort;
    }
  } else if (t.strip) {
    // nothing left to do — already removed
  }
  body.model = m.upstream_id;
  body.stream = stream;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (m.protocol === "anthropic") {
    headers["x-api-key"] = m.api_key;
    headers["anthropic-version"] = "2023-06-01";
    headers["accept"] = stream ? "text/event-stream" : "application/json";
  } else {
    headers["authorization"] = `Bearer ${m.api_key}`;
    headers["accept"] = stream ? "text/event-stream" : "application/json";
  }
  try {
    const extra = JSON.parse(m.extra_headers || "{}");
    for (const [k, v] of Object.entries(extra))
      if (typeof v === "string" && k.toLowerCase() !== "host") headers[k] = v;
  } catch {}

  const path = m.protocol === "anthropic" ? "/v1/messages" : "/chat/completions";
  return new Request(baseOf(m.base_url) + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
}

/** POST /v1/chat/completions (+ /v1/messages alias handled by caller). */
export async function handleChat(c: Context) {
  const started = Date.now();
  let body: Record<string, any>;
  try {
    body = await parseJson(c);
  } catch (e) {
    throw e;
  }
  const token = bearer(c);
  const modelId = typeof body.model === "string" ? body.model.trim() : undefined;
  gate(token, modelId);
  const key = findKey(token!)!;
  const m = resolveModel(modelId!);
  const stream = bool(body.stream);

  const req = upstreamRequest(m, body, stream);
  let res: Response;
  try {
    res = await fetch(req);
  } catch (e: any) {
    record(key.id, modelId!, emptyUsage(), 502);
    throw new HttpError(502, "upstream_unreachable", `provider unreachable: ${e?.message ?? e}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    record(key.id, modelId!, emptyUsage(), res.status);
    // relay provider error shape as-is (clients parse their own dialect errors)
    return new Response(text || JSON.stringify({ error: { message: "upstream error" } }), {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  }

  const ct = res.headers.get("content-type") ?? "";
  const u = emptyUsage();

  if (!stream || !ct.includes("event-stream")) {
    const text = await res.text().catch(() => "");
    try {
      capture(u, JSON.parse(text));
    } catch {}
    record(key.id, modelId!, u, res.status);
    return new Response(text, {
      status: res.status,
      headers: {
        "content-type": ct || "application/json",
        "x-arteri-latency-ms": String(Date.now() - started),
      },
    });
  }

  // SSE pass-through with a side-channel usage tap
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
            if (j?.type === "message_delta" && j.usage)
              capture(u, { usage: j.usage }); // anthropic cumulative delta
          } catch {}
        }
        ctrl.enqueue(chunk);
      },
      flush() {
        record(key.id, modelId!, u, res.status);
      },
    })
  );

  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-arteri-latency-ms": String(Date.now() - started),
  };
  return new Response(tapped, { status: res.status, headers });
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
  if (allowed.length) rows = rows.filter((r) => allowed.includes(r.public_id));
  return c.json({
    object: "list",
    data: rows.map((r) => ({
      id: r.public_id,
      object: "model",
      owned_by: r.owner,
      thinking: r.thinking_supported
        ? { supported: true, min_budget: r.min_thinking, max_budget: r.max_thinking }
        : { supported: false },
    })),
  });
}
