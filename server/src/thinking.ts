// Thinking engine — one clamp for every "reasoning" dialect.
//
// Client request field            -> normalized effort 0..1
//   openai: reasoning_effort ("low"|"medium"|"high" | xgpt5 tuple)
//   anthropic: thinking.budget_tokens
// Upstream dialect                -> emit the right shape, clamped to model min/max.
//
// A model with thinking_supported=0 strips all thinking fields entirely.

export type Dialect = "openai" | "anthropic";

/** Extract client-requested thinking as a 0..1 effort fraction. */
export function requestedEffort(body: Record<string, any>): number | null {
  const re = body.reasoning_effort;
  if (typeof re === "string") {
    const s = re.trim().toLowerCase();
    // x/gpt-5 style tuples: xhigh > high > medium > low > minimal
    const named: Record<string, number> = {
      minimal: 0.05,
      none: 0,
      off: 0,
      low: 0.25,
      medium: 0.55,
      high: 0.8,
      xhigh: 0.95,
      max: 1,
    };
    if (s in named) return named[s];
    const pct = parseFloat(s);
    if (!Number.isNaN(pct)) return Math.min(1, Math.max(0, pct / 100));
  }
  if (typeof re === "number" && Number.isFinite(re)) {
    return re > 1 ? Math.min(1, re / 100) : Math.max(0, re);
  }
  const th = body.thinking ?? body.reasoning;
  if (th && typeof th === "object") {
    if (th.type === "disabled" || th.enabled === false) return 0;
    const b = th.budget_tokens ?? th.budget ?? th.effort;
    if (typeof b === "number" && b > 0) {
      // budget is model-relative; treat 1024..128k as the practical span
      const t = (Math.log(b) - Math.log(1024)) / (Math.log(131072) - Math.log(1024));
      return Math.min(1, Math.max(0.05, t));
    }
    if (th.enabled === true) return 0.55; // bare "thinking on"
  }
  return null;
}

/**
 * Build the upstream thinking payload for a model row.
 * - model without support -> { strip: true } (caller removes fields)
 * - request below min     -> clamped up to min
 * - request above max     -> clamped down to max
 */
export function buildUpstreamThinking(
  body: Record<string, any>,
  m: { thinking_supported: number; min_thinking: number; max_thinking: number },
  dialect: Dialect,
  defaultBudget = 8192
): { strip: boolean; value?: Record<string, any> } {
  const supported = !!m.thinking_supported && m.max_thinking > 0;
  const eff = requestedEffort(body);

  // client didn't ask -> pass through untouched (don't silently burn tokens)
  if (eff === null) return { strip: false };

  if (!supported) return { strip: true };

  let frac = eff ?? 0.55;
  // model span [min,max] in tokens; map our 0.05..1 onto log-space of that span
  const lo = Math.max(1024, m.min_thinking || 1024);
  const hi = Math.max(lo + 1, m.max_thinking || lo);
  const budget = Math.round(Math.exp(Math.log(lo) + frac * (Math.log(hi) - Math.log(lo))));

  if (dialect === "anthropic") {
    return { strip: false, value: { type: "enabled", budget_tokens: budget } };
  }
  // OpenAI-style: single knob. Use vendor-native names when possible.
  return {
    strip: false,
    value:
      body.reasoning !== undefined && typeof body.reasoning === "object"
        ? { ...body.reasoning, effort: fracToOpenAIEffort(frac) }
        : { effort: fracToOpenAIEffort(frac) },
  };
}

function fracToOpenAIEffort(f: number): string {
  if (f <= 0.001) return "minimal";
  if (f < 0.4) return "low";
  if (f < 0.7) return "medium";
  if (f < 0.9) return "high";
  return "xhigh";
}

/** Remove client thinking keys before forwarding (when stripping). */
export function stripClientThinking(body: Record<string, any>) {
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinking;
}
