// Overview — live totals, 14-day flow chart (pure SVG), top models, recent requests.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Badge } from "../ui";

interface Overview {
  totals: { requests: number; tokens: number; reasoning: number };
  today: { requests: number; tokens: number };
  counts: { providers: number; models: number; keys: number };
  topModels: { model: string; requests: number; tokens: number }[];
  recent: {
    id: number;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    status: number;
    ts: number;
    key_label: string | null;
  }[];
  uptime: number;
  rss: number;
}

export function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 2 : 0) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 2 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + "k";
  return String(n);
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--muted)]">{label}</div>
      <div className="mono mt-1 text-2xl font-medium text-[var(--ink)]">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[var(--faint)]">{sub}</div>}
    </div>
  );
}

/** Pure-SVG area+line sparkline. Data = [{day, tokens}]. */
function Flow({ data }: { data: { day: string; tokens: number }[] }) {
  const w = 720;
  const h = 140;
  const pad = 2;
  if (!data.length)
    return (
      <div className="flex h-[140px] items-center justify-center text-sm text-[var(--faint)]">
        no traffic yet — route a request through /v1 to see the flow
      </div>
    );
  const max = Math.max(...data.map((d) => d.tokens), 1);
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => [pad + i * step, h - pad - (d.tokens / max) * (h - pad * 3)] as const);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="tokens per day">
      <defs>
        <linearGradient id="flow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity=".28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={pad}
          x2={w - pad}
          y1={h * f}
          y2={h * f}
          stroke="var(--panel-edge)"
          strokeDasharray="2 5"
        />
      ))}
      <path d={area} fill="url(#flow)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinejoin="round" />
      {pts.map((p, i) =>
        i === pts.length - 1 ? <circle key={i} cx={p[0]} cy={p[1]} r="3" fill="var(--accent)" /> : null
      )}
    </svg>
  );
}

const STATUS_TONE = (s: number): "ok" | "warn" | "err" => (s < 300 ? "ok" : s < 500 ? "warn" : "err");

export default function Overview() {
  const { data } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/api/admin/overview"),
    refetchInterval: 5000,
  });
  const daily = useQuery({
    queryKey: ["usage", "daily14"],
    queryFn: () =>
      api<{ daily: { day: string; tokens: number }[] }>("/api/admin/usage?days=14"),
    refetchInterval: 15000,
  });

  if (!data) return <p className="mt-8 text-sm text-[var(--muted)]">loading…</p>;
  const up = new Date(data.uptime * 1000).toISOString().slice(11, 19);

  return (
    <>
      <header className="mb-5 flex items-center gap-3">
        <span className="flex items-center gap-2">
          <span className="pulse-dot" />
          <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Badge>up {up}</Badge>
          <Badge>rss {fmt(data.rss)}</Badge>
          <Badge tone="accent">{data.counts.providers} providers</Badge>
          <Badge tone="accent">{data.counts.models} models</Badge>
          <Badge tone="accent">{data.counts.keys} keys</Badge>
        </span>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Requests" value={fmt(data.totals.requests)} sub={`${fmt(data.today.requests)} in 24h`} />
        <Stat label="Tokens routed" value={fmt(data.totals.tokens)} sub={`${fmt(data.today.tokens)} in 24h`} />
        <Stat label="Thinking tokens" value={fmt(data.totals.reasoning)} sub="reasoning output, all models" />
        <Stat
          label="Errors"
          value={fmt(
            Math.max(
              0,
              data.recent.filter((r) => r.status >= 400).length
            )
          )}
          sub="in recent window"
        />
      </section>

      <section className="mt-3 rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-[var(--muted)]">Flow — tokens per day (14d)</h2>
          <span className="mono text-[11px] text-[var(--faint)]">peak {fmt(Math.max(0, ...(daily.data?.daily ?? [{ day: "", tokens: 0 }]).map((d) => d.tokens)))}</span>
        </div>
        <Flow data={daily.data?.daily ?? []} />
      </section>

      <div className="mt-3 grid gap-3 lg:grid-cols-5">
        <section className="rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-[var(--muted)]">Top models</h2>
          {data.topModels.length === 0 && (
            <p className="text-xs text-[var(--faint)]">no traffic yet</p>
          )}
          <ul className="space-y-2.5">
            {data.topModels.map((m) => {
              const max = data.topModels[0]?.tokens || 1;
              return (
                <li key={m.model}>
                  <div className="mono mb-1 flex justify-between text-[12px]">
                    <span className="truncate pr-2 text-[var(--ink)]">{m.model}</span>
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

        <section className="overflow-hidden rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] lg:col-span-3">
          <h2 className="border-b border-[var(--panel-edge)] px-4 py-3 text-sm font-medium text-[var(--muted)]">
            Recent requests
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <tbody>
                {data.recent.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-xs text-[var(--faint)]" colSpan={5}>
                      nothing yet — point a client at POST /v1/chat/completions
                    </td>
                  </tr>
                )}
                {data.recent.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--panel-edge)]">
                    <td className="px-4 py-2">
                      <Badge tone={STATUS_TONE(r.status)}>{r.status}</Badge>
                    </td>
                    <td className="mono max-w-[220px] truncate px-2 py-2 text-[12px]">{r.model}</td>
                    <td className="mono px-2 py-2 text-right text-[12px] text-[var(--muted)]">
                      {fmt(r.prompt_tokens)} → {fmt(r.completion_tokens)}
                      {r.reasoning_tokens > 0 && (
                        <span className="ml-1 text-[var(--blue)]">+{fmt(r.reasoning_tokens)}</span>
                      )}
                    </td>
                    <td className="max-w-[120px] truncate px-2 py-2 text-xs text-[var(--faint)]">
                      {r.key_label || "—"}
                    </td>
                    <td className="mono px-4 py-2 text-right text-[11px] text-[var(--faint)]">
                      {new Date(r.ts).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
