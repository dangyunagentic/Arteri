// Shape guards at the trust boundary — the only place untrusted input is parsed.
// After these return, handlers can trust the shape.
import type { Context } from "hono";

export class BadRequest extends Error {}

export async function parseJson(c: Context): Promise<Record<string, any>> {
  try {
    const v = await c.req.json();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, any>;
  } catch {
    throw new BadRequest("invalid JSON body");
  }
}

export function str(v: any, field: string, max = 2048): string {
  if (typeof v !== "string" || !v.trim()) throw new BadRequest(`${field} is required`);
  if (v.length > max) throw new BadRequest(`${field} too long`);
  return v.trim();
}

export function optStr(v: any, max = 4096): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new BadRequest("expected string");
  if (v.length > max) throw new BadRequest("string too long");
  return v.trim() || undefined;
}

export function intOrNull(v: any, field: string, min = 0, max = 1e18): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || !Number.isInteger(n))
    throw new BadRequest(`${field} must be an integer between ${min} and ${max}`);
  return n;
}

export function bool(v: any): boolean {
  return v === true || v === 1 || v === "true" || v === "on";
}
