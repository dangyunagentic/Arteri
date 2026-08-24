// Public share page data — no auth, token in URL. Read-only usage + connection info.
import { Hono } from "hono";
import { db } from "./db";
import { getSetting } from "./db";

export const share = new Hono();

share.get("/api/share/:slug", (c) => {
  const slug = c.req.param("slug");
  const key = db
    .query("SELECT id, token, label, limit_total, used_total, share_slug FROM keys WHERE share_slug = ? AND enabled = 1")
    .get(slug) as any;
  if (!key) return c.json({ error: { code: "not_found", message: "share link not found or disabled" } }, 404);

  const dayStart = Date.now() - 24 * 3600_000;
  const totals = db
    .query(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens,
              COALESCE(SUM(reasoning_tokens),0) AS reasoning
       FROM usage WHERE key_id = ?`
    )
    .get(key.id) as any;
  const today = db
    .query(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens
       FROM usage WHERE key_id = ? AND ts > ?`
    )
    .get(key.id, dayStart) as any;

  const perModel = db
    .query(
      `SELECT model, COUNT(*) AS requests, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens
       FROM usage WHERE key_id = ? GROUP BY model ORDER BY tokens DESC LIMIT 10`
    )
    .all(key.id) as any[];

  const daily = db
    .query(
      `SELECT date(ts/1000,'unixepoch') AS day, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens
       FROM usage WHERE key_id = ? AND ts > ? GROUP BY day ORDER BY day`
    )
    .all(key.id, Date.now() - 14 * 24 * 3600_000);

  const remaining = key.limit_total === null ? null : Math.max(0, key.limit_total - key.used_total);
  const pctUsed = key.limit_total ? Math.min(100, (key.used_total / key.limit_total) * 100) : 0;

  return c.json({
    label: key.label || "shared endpoint",
    base_url: publicOrigin(c),
    api_key: key.token,
    limit_total: key.limit_total,
    used_total: key.used_total,
    remaining,
    pct_used: pctUsed,
    totals,
    today,
    per_model: perModel,
    daily,
  });
});

function publicOrigin(c: any): string {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  return `${proto}://${host}`;
}
