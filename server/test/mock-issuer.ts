// Mock OAuth issuer + mock Responses-API upstream for e2e-v3.
// issuer: http://localhost:9993 — authorize endpoint validates PKCE params,
// token endpoint issues access+refresh, /_codes stores issued codes.
import { Database } from "bun:sqlite";

const codes = new Map<string, { verifier: string; expires: number }>();

Bun.serve({
  port: 9993,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/oauth/authorize") {
      const cid = url.searchParams.get("client_id");
      const challenge = url.searchParams.get("code_challenge");
      const state = url.searchParams.get("state");
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      if (!cid || !challenge || !state)
        return new Response("missing pkce params", { status: 400 });
      // auto-"consent": issue code bound to verifier we learn at exchange (S256 check happens there via stored challenge)
      const code = crypto.randomUUID();
      codes.set(code, { verifier: challenge, expires: Date.now() + 300_000 });
      return new Response(null, {
        status: 302,
        headers: { location: `${redirect}?code=${code}&state=${state}` },
      });
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const form = await req.formData().catch(() => null);
      const grant = form?.get("grant_type");
      if (grant === "authorization_code") {
        const code = String(form?.get("code") ?? "");
        const verifier = String(form?.get("code_verifier") ?? "");
        const rec = codes.get(code);
        if (!rec || Date.now() > rec.expires) return json({ error: "invalid_grant" }, 400);
        codes.delete(code);
        // S256 verify: BASE64URL(SHA256(verifier)) === stored challenge
        const digest = Buffer.from(Bun.SHA256.hash(verifier, "hex"), "hex").toString("base64url");
        if (digest !== rec.verifier) return json({ error: "pkce_mismatch" }, 400);
        return json({
          access_token: "at_" + crypto.randomUUID(),
          refresh_token: "rt_" + crypto.randomUUID(),
          expires_in: 3600,
          id_token: idTokenWith("autumn@example.com"),
        });
      }
      if (grant === "refresh_token") {
        const rt = String(form?.get("refresh_token") ?? "");
        if (!rt.startsWith("rt_")) return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "at_refreshed_" + Date.now(), refresh_token: rt, expires_in: 3600 });
      }
      return json({ error: "unsupported_grant" }, 400);
    }
    if (url.pathname === "/responses" && req.method === "POST") {
      // minimal Responses API SSE
      const body = (await req.json()) as any;
      const model = body.model;
      const sse =
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `echo:${model}` })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } })}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("nf", { status: 404 });
  },
});
console.log("mock oauth issuer on :9993");

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function idTokenWith(email: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return `${h}.${p}.`;
}

export {};
