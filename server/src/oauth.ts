// OAuth core — PKCE authorize URL, code exchange, refresh, bulk token import.
// Tokens are stored per provider-row in providers.tokens as JSON:
//   { access_token, refresh_token?, expires_at (ms), account_id? }
import { db } from "./db";
import { catalogAny, type CatalogEntry } from "./catalog";

export interface TokenBlob {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // unix ms
  account_id?: string;
}

function b64url(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = b64url(bytes.buffer as ArrayBuffer);
  // S256: BASE64URL(SHA256(verifier)) — Bun.SHA256.sync for determinism
  const digest = Bun.SHA256.hash(verifier, "hex");
  const challenge = Buffer.from(digest, "hex").toString("base64url");
  return { verifier, challenge };
}

/** Build the authorize URL the admin opens in a browser. Returns state + verifier stored server-side. */
export function startOAuth(entry: CatalogEntry, redirectUri: string) {
  const cfg = entry.oauth!;
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomUUID().replace(/-/g, "");
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", state);
  if (cfg.codeChallengeMethod === "S256") {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(cfg.extraParams ?? {})) url.searchParams.set(k, v);
  return { url: url.toString(), state, verifier };
}

interface ExchangeResult {
  ok: boolean;
  status?: number;
  tokens?: TokenBlob;
  email?: string;
  error?: string;
}

export async function exchangeCode(
  entry: CatalogEntry,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<ExchangeResult> {
  const cfg = entry.oauth!;
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId!,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  if (cfg.clientSecretEnv) {
    const sec = process.env[cfg.clientSecretEnv];
    if (sec) body.client_secret = sec;
  }
  try {
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token)
      return { ok: false, status: res.status, error: j?.error_description ?? j?.error ?? `HTTP ${res.status}` };
    return {
      ok: true,
      tokens: {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Date.now() + Number(j.expires_in ?? 3600) * 1000,
        account_id: j.account_id,
      },
      email: typeof j.id_token === "string" ? emailFromIdToken(j.id_token) : undefined,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "exchange failed" };
  }
}

export async function refreshToken(entry: CatalogEntry, blob: TokenBlob): Promise<ExchangeResult> {
  const cfg = entry.oauth!;
  if (!blob.refresh_token) return { ok: false, error: "no refresh token stored" };
  try {
    let res: Response;
    if ((cfg.refreshEncoding ?? "form") === "json") {
      // anthropic-style JSON refresh
      res = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: blob.refresh_token,
          client_id: cfg.clientId!,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } else {
      const form: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: blob.refresh_token,
        client_id: cfg.clientId!,
      };
      if (cfg.clientSecretEnv) {
        const sec = process.env[cfg.clientSecretEnv];
        if (sec) form.client_secret = sec;
      }
      res = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(20_000),
      });
    }
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token)
      return { ok: false, status: res.status, error: j?.error_description ?? `HTTP ${res.status}` };
    return {
      ok: true,
      tokens: {
        ...blob,
        access_token: j.access_token,
        refresh_token: j.refresh_token ?? blob.refresh_token,
        expires_at: Date.now() + Number(j.expires_in ?? 3600) * 1000,
      },
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "refresh failed" };
  }
}

/** Get a valid access token for a provider row; refreshes when within 5 min of expiry. */
export async function validAccessToken(providerRow: {
  id: number;
  catalog: string;
  tokens: string;
}): Promise<{ token: string } | { error: string }> {
  let blob: TokenBlob;
  try {
    blob = JSON.parse(providerRow.tokens);
  } catch {
    return { error: "no stored oauth tokens" };
  }
  const entry = catalogAny(providerRow.catalog);
  if (!entry?.oauth) return { error: `provider ${providerRow.catalog} is not an oauth catalog entry` };
  if (blob.expires_at - Date.now() > 5 * 60_000) return { token: blob.access_token };
  const r = await refreshToken(entry, blob);
  if (!r.ok || !r.tokens) return { error: r.error ?? "refresh failed" };
  db.query("UPDATE providers SET tokens = ? WHERE id = ?").run(JSON.stringify(r.tokens), providerRow.id);
  return { token: r.tokens.access_token };
}

function emailFromIdToken(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString());
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bulk import: accept Codex CLI style auth.json content.
 * Accepts either a single object or an array of objects with
 * accessToken/refreshToken/idToken (+optional email) or nested OpenAI-style keys.
 */
export function parseBulkTokens(entry: CatalogEntry, raw: string): { email?: string; tokens: TokenBlob }[] {
  const parsed = JSON.parse(raw);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: { email?: string; tokens: TokenBlob }[] = [];
  for (const item of arr) {
    const access =
      item.accessToken ??
      item.access_token ??
      item.tokens?.access_token ??
      item.OPENAI_API_KEY; // codex auth.json sometimes stores only an api key — not usable for oauth
    const refresh = item.refreshToken ?? item.refresh_token ?? item.tokens?.refresh_token;
    if (typeof access !== "string" || !access) continue;
    const expiresAt =
      Number(item.expires_at ?? item.tokens?.expires_at ?? 0) * (String(item.expires_at ?? "").length <= 12 ? 1 : 1) ||
      Date.now() + 3600_000;
    out.push({
      email: typeof item.email === "string" ? item.email : undefined,
      tokens: {
        access_token: access,
        refresh_token: typeof refresh === "string" ? refresh : undefined,
        expires_at: expiresAt,
        account_id: item.account_id,
      },
    });
  }
  return out;
}
