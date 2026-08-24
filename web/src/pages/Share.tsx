// Public share page — anyone with the link sees base URL, API key, and remaining budget.
// Deliberately minimal: no console chrome, one card, live meter.
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Badge, CopyBtn } from "../ui";
import { fmt } from "./Overview";

interface ShareData {
  label: string;
  base_url: string;
  api_key: string;
  limit_total: number | null;
  used_total: number;
  remaining: number | null;
  pct_used: number;
  totals: { requests: number; tokens: number; reasoning: number };
  today: { requests: number; tokens: number };
  per_model: { model: string; requests: number; tokens: number }[];
  daily: { day: string; tokens: number }[];
}

function Gauge({ pct }: { pct: number }) {
  const r = 52;
  const c = Math.PI * r; // half circle length
  const tone = pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--amber)" : "var(--green)";
  return (
    <div className="relative mx-auto w-[150px]">
      <svg viewBox="0 0 140 84" className="w-full">
        <path
          d={`M18 74 A ${r} ${r} 0 0 1 122 74`}
          fill="none"
          stroke="var(--inset)"
          strokeWidth="11"
          strokeLinecap="round"
        />
        <path
          d={`M18 74 A ${r} ${r} 0 0 1 122 74`}
          fill="none"
          stroke={tone}
          strokeWidth="11"
          strokeLinecap="round"
          strokeDasharray={`${(Math.min(100, pct) / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="mono text-2xl font-medium" style={{ color: tone }}>
          {pct.toFixed(pct < 10 ? 1 : 0)}%
        </div>
        <div className="text-[11px] uppercase tracking-wider text-[var(--faint)]">used</div>
      </div>
    </div>
  );
}

export default function Share() {
  const { slug } = useParams({ from: "/share/$slug" });
  const { data, error, isLoading } = useQuery({
    queryKey: ["share", slug],
    queryFn: () => fetch(`/api/share/${slug}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error("link not found")))),
    refetchInterval: 10000,
  });

  if (isLoading)
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[var(--muted)]">loading…</p>
      </main>
    );
  if (error || !data)
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm rounded-lg border border-[rgba(217,45,32,.3)] bg-[var(--panel)] px-6 py-5 text-center">
          <h1 className="font-semibold text-[var(--red)]">Share link unavailable</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            This link was disabled or never existed.
          </p>
        </div>
      </main>
    );

  const s = data as ShareData;

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-4 py-10 sm:py-14">
      <header className="mb-8 flex items-center gap-2.5">
        <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="7" fill="var(--panel-edge)" />
          <path d="M6 22 Q14 22 16 16 T26 10" stroke="var(--accent)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <circle cx="26" cy="10" r="3" fill="var(--accent)" />
        </svg>
        <span className="text-sm font-semibold tracking-tight">Arteri</span>
        <span className="mono ml-auto text-[11px] text-[var(--faint)]">shared endpoint · live</span>
      </header>

      <h1 className="mb-1 text-xl font-semibold tracking-tight">{s.label}</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        Use these credentials in any OpenAI-compatible client. Usage updates live.
      </p>

      <section className="rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
          <Gauge pct={s.pct_used} />
          <div className="space-y-2.5">
            <div>
              <div className="text-xs uppercase tracking-wider text-[var(--muted)]">Budget</div>
              <div className="mono mt-0.5 flex flex-wrap items-baseline gap-x-3 text-sm">
                <span>{fmt(s.used_total)} used</span>
                {s.limit_total !== null ? (
                  <>
                    <span className="text-[var(--faint)]">of {fmt(s.limit_total)}</span>
                    <span className="text-[var(--green)]">{fmt(s.remaining ?? 0)} left</span>
                  </>
                ) : (
                  <Badge>no cap</Badge>
                )}
              </div>
            </div>
            <div className="mono grid grid-cols-3 gap-2 text-center text-[12px]">
              <div className="rounded border border-[var(--panel-edge)] bg-[var(--inset)] px-2 py-2">
                <div className="text-base text-[var(--ink)]">{fmt(s.today.tokens)}</div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--faint)]">tokens 24h</div>
              </div>
              <div className="rounded border border-[var(--panel-edge)] bg-[var(--inset)] px-2 py-2">
                <div className="text-base text-[var(--ink)]">{fmt(s.totals.requests)}</div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--faint)]">requests</div>
              </div>
              <div className="rounded border border-[var(--panel-edge)] bg-[var(--inset)] px-2 py-2">
                <div className="text-base text-[var(--blue)]">{fmt(s.totals.reasoning)}</div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--faint)]">thinking</div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-3 border-t border-[var(--panel-edge)] pt-5">
          <Row label="Base URL">
            <code className="mono min-w-0 flex-1 break-all">{s.base_url}/v1</code>
            <CopyBtn text={`${s.base_url}/v1`} />
          </Row>
          <Row label="API key">
            <code className="mono min-w-0 flex-1 break-all">{s.api_key}</code>
            <CopyBtn text={s.api_key} />
          </Row>
          <Row label="Chat endpoint">
            <code className="mono min-w-0 flex-1 break-all">POST {s.base_url}/v1/chat/completions</code>
            <CopyBtn text={`curl ${s.base_url}/v1/chat/completions \\\n  -H "Authorization: Bearer ${s.api_key}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}]}'`} label="copy curl" />
          </Row>
        </div>
      </section>

      {s.per_model.length > 0 && (
        <section className="mt-3 rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] p-4 sm:p-5">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            Where the tokens go
          </h2>
          <ul className="space-y-2.5">
            {s.per_model.map((m) => {
              const max = s.per_model[0]?.tokens || 1;
              return (
                <li key={m.model}>
                  <div className="mono mb-1 flex justify-between text-[12px]">
                    <span className="truncate pr-2">{m.model}</span>
                    <span className="text-[var(--faint)]">{fmt(m.tokens)}</span>
                  </div>
                  <div className="h-1 rounded bg-[var(--inset)]">
                    <div
                      className="h-1 rounded bg-[var(--accent)]"
                      style={{ width: `${Math.max(3, (m.tokens / max) * 100)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="mt-6 text-center text-[11px] leading-relaxed text-[var(--faint)]">
        keep this link private — it contains the live API key
        <br />
        powered by Arteri
      </footer>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wider text-[var(--muted)]">{label}</span>
      {children}
    </div>
  );
}
