// Usage — per-day table + per-model split for a window, optional key filter.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Select } from "../ui";
import { fmt } from "./Overview";

interface UsageData {
  daily: { day: string; requests: number; tokens: number; reasoning: number }[];
  perModel: { model: string; requests: number; tokens: number }[];
  perProvider?: { provider_slug: string; requests: number; tokens: number }[];
  errors: number;
  days: number;
}

export default function UsagePage() {
  const [days, setDays] = useState(14);
  const [keyId, setKeyId] = useState("");
  const { data: usage } = useQuery({
    queryKey: ["usage", days, keyId],
    queryFn: () =>
      api<UsageData>(`/api/admin/usage?days=${days}${keyId ? `&key_id=${keyId}` : ""}`),
    refetchInterval: 10000,
  });
  const { data: keys } = useQuery({
    queryKey: ["keys"],
    queryFn: () => api<{ id: number; label: string; token: string }[]>("/api/admin/keys"),
  });

  const total = (usage?.daily ?? []).reduce((a, d) => a + d.tokens, 0);

  return (
    <>
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Usage</h1>
        <span className="text-sm text-[var(--muted)]">{fmt(total)} tokens in window</span>
        <div className="ml-auto flex gap-2">
          <Select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="window"
            className="w-auto"
          >
            <option value={1}>24 hours</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </Select>
          <Select
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            aria-label="filter by key"
            className="w-auto"
          >
            <option value="">all keys</option>
            {(keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.label || `key #${k.id}`}
              </option>
            ))}
          </Select>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-5">
        <section className="overflow-hidden rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] lg:col-span-3">
          <h2 className="border-b border-[var(--panel-edge)] px-4 py-3 text-sm font-medium text-[var(--muted)]">
            Per day
          </h2>
          <div className="max-h-[480px] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-[var(--panel)]">
                <tr className="border-b border-[var(--panel-edge)] text-xs uppercase tracking-wider text-[var(--muted)]">
                  <th className="px-4 py-2 font-medium">Day</th>
                  <th className="px-3 py-2 text-right font-medium">Requests</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-4 py-2 text-right font-medium">Thinking</th>
                </tr>
              </thead>
              <tbody>
                {(usage?.daily ?? []).map((d) => (
                  <tr key={d.day} className="border-t border-[var(--panel-edge)]">
                    <td className="mono px-4 py-2 text-[12px]">{d.day}</td>
                    <td className="mono px-3 py-2 text-right text-[12px]">{fmt(d.requests)}</td>
                    <td className="mono px-3 py-2 text-right text-[12px]">{fmt(d.tokens)}</td>
                    <td className="mono px-4 py-2 text-right text-[12px] text-[var(--blue)]">
                      {d.reasoning ? fmt(d.reasoning) : "—"}
                    </td>
                  </tr>
                ))}
                {usage && usage.daily.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-sm text-[var(--faint)]">
                      no usage in this window
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] lg:col-span-2">
          <h2 className="flex items-center justify-between border-b border-[var(--panel-edge)] px-4 py-3 text-sm font-medium text-[var(--muted)]">
            Per model
            {usage && usage.errors > 0 && <Badge tone="warn">{fmt(usage.errors)} errors</Badge>}
          </h2>
          <ul className="max-h-[480px] space-y-3 overflow-y-auto p-4">
            {(usage?.perProvider ?? []).length > 1 && (
              <li className="flex flex-wrap gap-1.5 pb-1">
                {(usage?.perProvider ?? []).map((p) => (
                  <Badge key={p.provider_slug} tone="neutral">
                    {p.provider_slug || "custom"} · {fmt(p.tokens)}
                  </Badge>
                ))}
              </li>
            )}
            {(usage?.perModel ?? []).map((m) => {
              const max = usage?.perModel[0]?.tokens || 1;
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
            {usage && usage.perModel.length === 0 && (
              <li className="py-6 text-center text-sm text-[var(--faint)]">nothing yet</li>
            )}
          </ul>
        </section>
      </div>
    </>
  );
}
