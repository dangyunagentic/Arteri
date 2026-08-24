// Settings — token savers (RTK / Headroom / Caveman / Ponytail).
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ApiError } from "../api";
import { ErrorText } from "../ui";

type Level = "off" | "lite" | "full" | "ultra";
interface Savers {
  rtk: Level;
  headroom: Level;
  caveman: Level;
  ponytail: Level;
}

const LEVELS: { v: Level; label: string }[] = [
  { v: "off", label: "Off" },
  { v: "lite", label: "Lite" },
  { v: "full", label: "Full" },
  { v: "ultra", label: "Ultra" },
];

const SAVER_META: Record<
  keyof Savers,
  { name: string; blurb: string; detail: string }
> = {
  rtk: {
    name: "RTK — tool output compression",
    blurb: "60–90% fewer input tokens on noisy tool output.",
    detail:
      "Detects git diff/log/status, grep/find results, ls, tree and build logs inside tool messages, then compresses them before they reach the model.",
  },
  headroom: {
    name: "Headroom — history trim",
    blurb: "Old tool outputs replaced with stubs; recent ones kept.",
    detail:
      "Keeps the last N tool outputs intact (Ultra=1, Full=2, Lite=4) and stubs older ones so long agent sessions stop ballooning.",
  },
  caveman: {
    name: "Caveman — terse output",
    blurb: "~65% fewer output tokens. Up to 87% at Ultra.",
    detail:
      "Injects a system prompt that makes the model answer in clipped, filler-free sentences. Code blocks, paths and commands stay exact.",
  },
  ponytail: {
    name: "Ponytail — lazy senior dev",
    blurb: "YAGNI ladder enforced on every response.",
    detail:
      "Injects the lazy-senior-dev persona: stdlib first, shortest diff wins, deletion over addition. Lite names the lazier alternative; Ultra challenges the requirement itself.",
  },
};

export function SettingsPage() {
  const qc = useQueryClient();
  const savers = useQuery({ queryKey: ["savers"], queryFn: () => api<Savers>("/api/admin/settings/savers") });
  const [err, setErr] = useState<string | null>(null);
  const setLevel = useMutation({
    mutationFn: async ({ k, v }: { k: keyof Savers; v: Level }) =>
      api<Savers>(`/api/admin/settings/savers`, { method: "PATCH", body: JSON.stringify({ [k]: v }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["savers"] }),
    onError: (e) => setErr((e as ApiError extends { message: infer M } ? M : never) as any),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Token savers</h1>
        <p className="text-sm text-[var(--muted)]">
          Applied to every request through Arteri, per connection or globally. Compression runs before thinking-clamps.
        </p>
      </header>

      {(Object.keys(SAVER_META) as (keyof Savers)[]).map((k) => {
        const meta = SAVER_META[k];
        const cur = savers.data?.[k] ?? "off";
        return (
          <section key={k} className="rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--panel)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{meta.name}</h2>
                <p className="mt-0.5 text-xs text-[var(--muted)]">{meta.blurb}</p>
                <p className="mt-1 max-w-prose text-[11px] leading-snug text-[var(--faint)]">{meta.detail}</p>
              </div>
              <div className="flex shrink-0 rounded-full border border-[var(--panel-edge)] p-0.5">
                {LEVELS.map((l) => (
                  <button
                    key={l.v}
                    onClick={() => setLevel.mutate({ k, v: l.v })}
                    disabled={setLevel.isPending}
                    className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                      cur === l.v ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:bg-[var(--inset)]"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
        );
      })}
      <ErrorText msg={err} />
    </div>
  );
}
