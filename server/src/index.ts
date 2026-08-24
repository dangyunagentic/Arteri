// Arteri entrypoint — one process: /v1 proxy + /api admin + /share pages + SPA.
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { admin } from "./admin";
import { share } from "./share";
import { handleChat, handleModels, HttpError } from "./proxy";
import { BadRequest } from "./validate";
import { join } from "node:path";

const app = new Hono();

// ---------- public inference API ----------
app.post("/v1/chat/completions", (c) => handleChat(c));
// Anthropic-native clients: same pipeline, body carries model too.
app.post("/v1/messages", (c) => handleChat(c));
app.get("/v1/models", (c) => handleModels(c));

app.onError((err, c) => {
  if (err instanceof HttpError)
    return c.json({ error: { type: "arteri_error", code: err.code, message: err.message } }, err.status as any);
  if (err instanceof BadRequest)
    return c.json({ error: { type: "arteri_error", code: "bad_request", message: err.message } }, 400);
  console.error("[arteri] unhandled:", err);
  return c.json({ error: { type: "server_error", message: "internal error" } }, 500);
});

// ---------- console + share ----------
app.route("/api/admin", admin);
app.route("/", share);

// ---------- SPA ----------
const webDist = join(import.meta.dir, "../../web/dist");
const spaFallback = serveStatic({ root: webDist, rewriteRequestPath: () => "/index.html" });
app.get("*", async (c, next) => {
  const hit = await serveStatic({ root: webDist })(c, async () => {});
  if (hit instanceof Response && hit.status !== 404) return hit;
  return spaFallback(c, next);
});

const port = Number(process.env.PORT || 8787);
console.log(`arteri listening on http://localhost:${port}`);
console.log(`  inference : POST /v1/chat/completions | /v1/messages | GET /v1/models`);
console.log(`  console   : /  (login)`);
export default { port, fetch: app.fetch };
