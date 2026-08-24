// Token savers config — settings-backed singleton + apply wrapper.
import { getSetting, setSetting } from "./db";
import {
  applySavers as apply,
  DEFAULT_SAVERS,
  type SaversConfig,
  type SaverLevel,
} from "./savers";

const KEY = "savers";

export function getSaversConfig(): SaversConfig {
  try {
    const raw = getSetting(KEY);
    if (!raw) return { ...DEFAULT_SAVERS };
    const parsed = JSON.parse(raw) as Partial<SaversConfig>;
    const ok = (v: any): v is SaverLevel => ["off", "lite", "full", "ultra"].includes(v);
    return {
      rtk: ok(parsed.rtk) ? parsed.rtk : DEFAULT_SAVERS.rtk,
      headroom: ok(parsed.headroom) ? parsed.headroom : DEFAULT_SAVERS.headroom,
      caveman: ok(parsed.caveman) ? parsed.caveman : DEFAULT_SAVERS.caveman,
      ponytail: ok(parsed.ponytail) ? parsed.ponytail : DEFAULT_SAVERS.ponytail,
    };
  } catch {
    return { ...DEFAULT_SAVERS };
  }
}

export function setSaversConfig(next: Partial<SaversConfig>): SaversConfig {
  const cur = getSaversConfig();
  const merged = { ...cur, ...next };
  setSetting(KEY, JSON.stringify(merged));
  return merged;
}

export { apply };