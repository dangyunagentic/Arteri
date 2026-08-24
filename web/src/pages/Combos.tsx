// Combos — fallback chains / round-robin / weighted groups exposed as one model id.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ApiError } from "../api";
import { Badge, Button, ErrorText, Modal, TextInput } from "../ui";

interface ComboModel {
  position: number;
  target: string;
  weight: number;
}
interface Combo {
  id: number;
  public_id: string;
  strategy: "fallback" | "round_robin" | "weighted";
  enabled: number;
  models: ComboModel[];
}
interface ProviderRow {
  id: number;
  slug: string;
  name: string;
}
interface CachedModel {
  upstream_id: string;
  display_name: string;
}

const STRATEGY_HELP: Record<Combo["strategy"], string> = {
  fallback: "Try in order — first success wins. Subscription first, cheap backup, free emergency.",
  round_robin: "Spread requests across all models evenly.",
  weighted: "Random pick weighted by each model's weight (higher = more traffic).",
};

export function CombosPage() {
  const qc = useQueryClient();
  const combos = useQuery({ queryKey: ["combos"], queryFn: () => api<Combo[]>("/api/admin/combos") });
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api<ProviderRow[]>("/api/admin/providers") });
  const [editing, setEditing] = useState<Combo | "new" | null>(null);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Combos</h1>
          <p className="text-sm text-[var(--muted)]">
            Chain models into one routable ID. Clients just send <span className="mono">model: &lt;combo-id&gt;</span>.
          </p>
        </div>
        <Button onClick={() => setEditing("new")}>New combo</Button>
      </header>

      {!combos.data?.length ? (
        <p className="rounded-[var(--radius)] border border-dashed border-[var(--panel-edge)] p-8 text-center text-sm text-[var(--muted)]">
          No combos yet. Create one — e.g. <span className="mono">premium-coding</span>: opus first, then glm, then a free tier.
        </p>
      ) : (
        <div className="space-y-3">
          {combos.data.map((c) => (
            <div key={c.id} className="rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--panel)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="mono text-sm font-semibold">{c.public_id}</span>
                  <Badge tone={c.enabled ? "ok" : "muted"}>{c.enabled ? "on" : "off"}</Badge>
                  <Badge tone={c.strategy === "fallback" ? "accent" : c.strategy === "round_robin" ? "warn" : "info"}>
                    {c.strategy.replace("_", "-")}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={async () => {
                      if (!confirm(`Delete combo ${c.public_id}?`)) return;
                      await api(`/api/admin/combos/${c.id}`, { method: "DELETE" });
                      qc.invalidateQueries({ queryKey: ["combos"] });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-xs text-[var(--faint)]">{STRATEGY_HELP[c.strategy]}</p>
              <ol className="mt-3 space-y-1">
                {c.models.map((m) => (
                  <li key={m.position} className="flex items-center gap-2 text-sm">
                    <span className="w-5 text-right text-xs tabular-nums text-[var(--faint)]">{m.position + 1}.</span>
                    <span className="mono">{m.target}</span>
                    {c.strategy === "weighted" && <Badge tone="muted">w{m.weight}</Badge>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ComboEditor
          combo={editing === "new" ? null : editing}
          providers={providers.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["combos"] });
          }}
        />
      )}
    </div>
  );
}

function ComboEditor({
  combo,
  providers,
  onClose,
  onSaved,
}: {
  combo: Combo | null;
  providers: ProviderRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [publicId, setPublicId] = useState(combo?.public_id ?? "");
  const [strategy, setStrategy] = useState<Combo["strategy"]>(combo?.strategy ?? "fallback");
  const [targets, setTargets] = useState<{ target: string; weight: number }[]>(
    combo?.models.map((m) => ({ target: m.target, weight: m.weight })) ?? []
  );
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({ public_id: publicId, strategy, models: targets });
      const r = await fetch(combo ? `/api/admin/combos/${combo.id}` : "/api/admin/combos", {
        method: combo ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!r.ok) throw new Error(((await r.json()) as ApiError).error?.message ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: onSaved,
    onError: (e) => setErr((e as Error).message),
  });

  // flat list of every cached model across connections, for the picker
  const caches = useQuery({
    queryKey: ["all-caches", providers.map((p) => p.id).join(",")],
    queryFn: async () => {
      const out: { providerSlug: string; models: CachedModel[] }[] = [];
      for (const p of providers) {
        try {
          out.push({ providerSlug: p.slug, models: await api<CachedModel[]>(`/api/admin/providers/${p.id}/cached-models`) });
        } catch {}
      }
      return out;
    },
    enabled: providers.length > 0,
  });

  const move = (i: number, dir: -1 | 1) => {
    setTargets((t) => {
      const next = [...t];
      const j = i + dir;
      if (j < 0 || j >= next.length) return t;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  return (
    <Modal title={combo ? `Edit ${combo.public_id}` : "New combo"} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <label className="block space-y-1">
          <span className="text-xs font-medium text-[var(--muted)]">Combo ID (what clients send as model)</span>
          <TextInput value={publicId} onChange={(e) => setPublicId(e.target.value)} placeholder="premium-coding" />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-[var(--muted)]">Strategy</span>
          <select className="input" value={strategy} onChange={(e) => setStrategy(e.target.value as Combo["strategy"])}>
            <option value="fallback">Fallback — try in order</option>
            <option value="round_robin">Round robin</option>
            <option value="weighted">Weighted random</option>
          </select>
          <span className="block text-[11px] text-[var(--faint)]">{STRATEGY_HELP[strategy]}</span>
        </label>

        {/* chain */}
        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--muted)]">Models ({targets.length}/10)</span>
          {targets.length === 0 && (
            <p className="rounded-md border border-dashed border-[var(--panel-edge)] px-3 py-2 text-xs text-[var(--muted)]">
              Add from the pool below.
            </p>
          )}
          {targets.map((t, i) => (
            <div key={`${t.target}-${i}`} className="flex items-center gap-2 rounded-md border border-[var(--panel-edge)] bg-[var(--inset)] px-2 py-1.5">
              <span className="text-xs tabular-nums text-[var(--faint)]">{i + 1}</span>
              <span className="mono flex-1 truncate text-xs">{t.target}</span>
              {strategy === "weighted" && (
                <input
                  type="number"
                  min={1}
                  value={t.weight}
                  onChange={(e) =>
                    setTargets((arr) => arr.map((x, j) => (j === i ? { ...x, weight: Math.max(1, Number(e.target.value) || 1) } : x)))
                  }
                  className="input w-20 py-0.5 text-xs"
                />
              )}
              <button type="button" className="px-1 text-xs hover:text-[var(--fg)]" onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button
                type="button"
                className="px-1 text-xs hover:text-[var(--fg)]"
                onClick={() => move(i, 1)}
                disabled={i === targets.length - 1}
              >
                ↓
              </button>
              <button type="button" className="px-1 text-xs text-red-600" onClick={() => setTargets((arr) => arr.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
        </div>

        {/* picker */}
        <details className="rounded-md border border-[var(--panel-edge)]">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-[var(--muted)]">
            Model pool {caches.isFetching ? "(loading...)" : ""}
          </summary>
          <div className="max-h-56 space-y-2 overflow-y-auto border-t border-[var(--panel-edge)] p-2">
            {(caches.data ?? []).map(({ providerSlug, models }) => (
              <div key={providerSlug}>
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">{providerSlug}</div>
                <div className="flex flex-wrap gap-1">
                  {models
                    .filter((m) => !targets.some((t) => t.target === `${providerSlug}:${m.upstream_id}`))
                    .slice(0, 40)
                    .map((m) => (
                      <button
                        key={m.upstream_id}
                        type="button"
                        className="mono rounded border border-[var(--panel-edge)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--inset)]"
                        onClick={() => setTargets((arr) => [...arr, { target: `${providerSlug}:${m.upstream_id}`, weight: 100 }])}
                      >
                        + {m.upstream_id}
                      </button>
                    ))}
                </div>
              </div>
            ))}
            {!caches.data?.some((c) => c.models.length) && (
              <p className="px-2 pb-2 text-xs text-[var(--muted)]">
                No cached models yet — open Providers → Models → “Fetch latest” on your connections first.
              </p>
            )}
          </div>
        </details>

        <ErrorText msg={err} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!publicId || targets.length === 0 || save.isPending}>
            Save combo
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function CombosDefault() {
  return <CombosPage />;
}
