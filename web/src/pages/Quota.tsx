// Quota tracker — per-connection usage bars + reset countdowns (local + upstream where available).
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button } from "../ui";

interface QuotaRow {
  connection_id: number;
  slug: string;
  name: string;
  catalog: string;
  window_kind: string;
  used: number | null;
  total: number | null;
  remaining: number | null;
  resets_at: number | null;
  fetched_at: number | null;
}
interface KeyRow {
  id: number;
  label: string;
  limit_total: number | null;
  used_total: number;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 || n < 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}
function countdown(ts: number | null): string | null {
  if (!ts) return null;
  const ms = ts - Date.now();
  if (ms <= 0) return "resetting...";
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  if (h > 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${Math.max(0, m)}m`;
}

export function QuotaPage() {
  const qc = useQueryClient();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000); // re-render countdowns
    return () => clearInterval(t);
  }, []);
  void tick;

  const quota = useQuery({ queryKey: ["quota"], queryFn: () => api<QuotaRow[]>("/api/admin/quota"), refetchInterval: 60_000 });
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => api<KeyRow[]>("/api/admin/keys"), refetchInterval: 15_000 });

  const refresh = useMutation({
    mutationFn: async () => api("/api/admin/quota/refresh", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quota"] }),
  });

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Quota tracker</h1>
          <p className="text-sm text-[var(--muted)]">
            Upstream quota snapshots where providers expose them; key budgets tracked locally in real time.
          </p>
        </div>
        <Button variant="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? "Refreshing..." : "Refresh upstream"}
        </Button>
      </header>

      {/* upstream quotas */}
      {!quota.data?.length ? (
        <p className="rounded-[var(--radius)] border border-dashed border-[var(--panel-edge)] p-6 text-center text-sm text-[var(--muted)]">
          No upstream quota snapshots yet. Providers without a public usage API won't appear here — key budgets below are always live.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {quota.data.map((q) => {
            const pct = q.total && q.used !== null ? Math.min(100, (q.used / q.total) * 100) : null;
            const cd = countdown(q.resets_at);
            return (
              <div key={q.connection_id} className="rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--panel)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{q.name}</span>
                  <Badge tone={pct !== null && pct > 85 ? "err" : pct !== null && pct > 60 ? "warn" : "ok"}>
                    {pct !== null ? `${Math.round(pct)}% used` : "no data"}
                  </Badge>
                </div>
                <div className="mono mt-0.5 text-[10px] text-[var(--faint)]">{q.slug}</div>
                {q.total && q.used !== null && (
                  <>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--inset)]">
                      <div
                        className={`h-full rounded-full ${pct! > 85 ? "bg-red-500" : pct! > 60 ? "bg-amber-500" : "bg-emerald-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mono mt-1 flex justify-between text-[11px] text-[var(--muted)]">
                      <span>
                        {fmtTokens(q.used)} / {fmtTokens(q.total)}
                      </span>
                      <span>{cd ?? ""}</span>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* key budgets — always local-truth */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Key budgets</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {(keys.data ?? []).map((k) => {
            if (k.limit_total === null)
              return (
                <div key={k.id} className="rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--panel)] p-3">
                  <div className="flex items-center justify-between">
                    <span className="truncate text-sm">{k.label || "(unlabeled)"}</span>
                    <Badge tone="info">unlimited</Badge>
                  </div>
                  <div className="mono mt-1 text-[11px] text-[var(--muted)]">{fmtTokens(k.used_total)} used</div>
                </div>
              );
            const pct = Math.min(100, (k.used_total / k.limit_total) * 100);
            const tone = pct > 85 ? "err" : pct > 60 ? "warn" : "ok";
            return (
              <div key={k.id} className="rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--panel)] p-3">
                <div className="flex items-center justify-between">
                  <span className="truncate text-sm font-medium">{k.label || "(unlabeled)"}</span>
                  <Badge tone={tone as any}>{Math.round(pct)}%</Badge>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--inset)]">
                  <div
                    className={`h-full rounded-full ${tone === "err" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mono mt-1 flex justify-between text-[11px] text-[var(--muted)]">
                  <span>{fmtTokens(k.used_total)}</span>
                  <span>{fmtTokens(k.limit_total)}</span>
                </div>
              </div>
            );
          })}
          {!keys.data?.length && (
            <p className="rounded-md border border-dashed border-[var(--panel-edge)] p-4 text-xs text-[var(--muted)]">No keys yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

export default function QuotaDefault() {
  return <QuotaPage />;
}
