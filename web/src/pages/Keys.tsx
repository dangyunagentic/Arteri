// API Keys — token lifecycle, limits, model allowlist, share links.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Button, CopyBtn, ErrorText, Field, Modal, TextInput, Toggle } from "../ui";
import { fmt } from "./Overview";

interface KeyRow {
  id: number;
  token: string;
  label: string;
  enabled: number;
  limit_total: number | null;
  used_total: number;
  rpm: number | null;
  allowed_models: string;
  share_slug: string | null;
  remaining: number | null;
  pct_used: number;
}

function Meter({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null)
    return (
      <div className="flex items-center gap-2">
        <Badge tone="ok">unlimited</Badge>
        <span className="mono text-[11px] text-[var(--faint)]">{fmt(used)} used</span>
      </div>
    );
  const pct = Math.min(100, (used / limit) * 100);
  const tone = pct >= 90 ? "err" : pct >= 70 ? "warn" : "ok";
  const color = tone === "err" ? "var(--red)" : tone === "warn" ? "var(--amber)" : "var(--green)";
  return (
    <div className="min-w-[180px]">
      <div className="mono mb-1 flex justify-between text-[11px]">
        <span className="text-[var(--muted)]">
          {fmt(used)} / {fmt(limit)}
        </span>
        <span style={{ color }}>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--inset)]">
        <div
          className="h-1.5 rounded-full transition-[width]"
          style={{ width: `${Math.max(2, pct)}%`, background: color }}
        />
      </div>
    </div>
  );
}

export default function Keys() {
  const qc = useQueryClient();
  const { data: keys, refetch } = useQuery({ queryKey: ["keys"], queryFn: () => api<KeyRow[]>("/api/admin/keys") });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<KeyRow | null>(null);
  const [editing, setEditing] = useState<KeyRow | null>(null);

  return (
    <>
      <header className="mb-5 flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">API Keys</h1>
        <span className="text-sm text-[var(--muted)]">token budgets, RPM caps, share links</span>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          Create key
        </Button>
      </header>

      <div className="space-y-3">
        {(keys ?? []).map((k) => (
          <article key={k.id} className="rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-medium">{k.label || `key #${k.id}`}</h2>
                  {k.enabled ? <Badge tone="ok">active</Badge> : <Badge tone="err">disabled</Badge>}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="mono truncate text-[12px] text-[var(--muted)]">{mask(k.token)}</code>
                  <CopyBtn text={k.token} label="copy" />
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-4">
                <Meter used={k.used_total} limit={k.limit_total} />
                <span className="mono text-[11px] text-[var(--faint)]">
                  rpm: {k.rpm ?? "∞"}
                </span>
                <span className="flex items-center gap-1.5">
                  {k.share_slug && <Badge tone="accent">shared</Badge>}
                </span>
              </div>
            </div>

            <footer className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--panel-edge)] pt-3">
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setEditing(k)}>
                Edit
              </Button>
              <RotateBtn id={k.id} onDone={() => refetch()} />
              <ResetUsageBtn id={k.id} onDone={() => qc.invalidateQueries({ queryKey: ["keys"] })} />
              <ShareBtn k={k} onDone={() => refetch()} />
              {k.share_slug && <CopyShare slug={k.share_slug} />}
              <Button
                variant="danger"
                className="ml-auto px-2 py-1 text-xs"
                onClick={async () => {
                  if (!confirm(`Delete '${k.label || "key #" + k.id}'?`)) return;
                  await api(`/api/admin/keys/${k.id}`, { method: "DELETE" });
                  qc.invalidateQueries({ queryKey: ["keys"] });
                }}
              >
                Delete
              </Button>
            </footer>
          </article>
        ))}
        {keys && keys.length === 0 && (
          <div className="rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] px-4 py-10 text-center text-sm text-[var(--faint)]">
            no keys yet — create one and point your CLI at the router
          </div>
        )}
      </div>

      {creating && (
        <KeyModal
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setCreated(k);
            qc.invalidateQueries({ queryKey: ["keys"] });
          }}
        />
      )}
      {editing && (
        <KeyModal
          existing={editing}
          onClose={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["keys"] });
          }}
        />
      )}
      {created && <CreatedModal k={created} onClose={() => setCreated(null)} />}
    </>
  );
}

function mask(t: string) {
  return t.slice(0, 13) + "…" + t.slice(-4);
}

function RotateBtn({ id, onDone }: { id: number; onDone: () => void }) {
  const [tok, setTok] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        className="px-2 py-1 text-xs"
        onClick={async () => {
          if (!confirm("Rotate token? The old key stops working immediately.")) return;
          const r = await api<{ token: string }>(`/api/admin/keys/${id}/rotate`, { method: "POST" });
          setTok(r.token);
          onDone();
        }}
      >
        Rotate
      </Button>
      {tok && (
        <Modal open onClose={() => setTok(null)} title="New token">
          <p className="mb-3 text-sm text-[var(--muted)]">Copy it now — it is shown once.</p>
          <div className="flex items-center gap-2 rounded border border-[var(--panel-edge)] bg-[var(--inset)] p-2.5">
            <code className="mono min-w-0 flex-1 break-all text-[12px]">{tok}</code>
            <CopyBtn text={tok} />
          </div>
        </Modal>
      )}
    </>
  );
}

function ResetUsageBtn({ id, onDone }: { id: number; onDone: () => void }) {
  return (
    <Button
      variant="ghost"
      className="px-2 py-1 text-xs"
      onClick={async () => {
        await api(`/api/admin/keys/${id}/reset-usage`, { method: "POST" });
        onDone();
      }}
    >
      Reset usage
    </Button>
  );
}

function ShareBtn({ k, onDone }: { k: KeyRow; onDone: () => void }) {
  return (
    <Button
      variant="ghost"
      className="px-2 py-1 text-xs"
      onClick={async () => {
        await api(`/api/admin/keys/${k.id}/share`, {
          method: "POST",
          body: JSON.stringify({ enable: !k.share_slug }),
        });
        onDone();
      }}
    >
      {k.share_slug ? "Disable share" : "Share…"}
    </Button>
  );
}

function CopyShare({ slug }: { slug: string }) {
  const url = `${location.origin}/share/${slug}`;
  return (
    <a
      href={`/share/${slug}`}
      target="_blank"
      rel="noreferrer"
      className="mono inline-flex shrink-0 items-center rounded border border-[rgba(89,167,255,.35)] px-1.5 py-0.5 text-[11px] text-[var(--blue)] transition-colors hover:bg-[rgba(89,167,255,.1)]"
    >
      open share page ↗
    </a>
  );
}

function CreatedModal({ k, onClose }: { k: KeyRow; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Key created">
      <p className="mb-3 text-sm text-[var(--muted)]">Copy it now — it is shown once.</p>
      <div className="mb-4 flex items-center gap-2 rounded border border-[var(--panel-edge)] bg-[var(--inset)] p-2.5">
        <code className="mono min-w-0 flex-1 break-all text-[12px]">{k.token}</code>
        <CopyBtn text={k.token} />
      </div>
      <Field label="Endpoint">
        <div className="mono rounded border border-[var(--panel-edge)] bg-[var(--inset)] p-2.5 text-[12px]">
          POST {location.origin}/v1/chat/completions
        </div>
      </Field>
    </Modal>
  );
}

function KeyModal({
  existing,
  onClose,
  onCreated,
}: {
  existing?: KeyRow | null;
  onClose: () => void;
  onCreated: (k: KeyRow) => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [limitOn, setLimitOn] = useState(existing?.limit_total != null);
  const [limit, setLimit] = useState(String(existing?.limit_total ?? 1_000_000_000));
  const [rpmOn, setRpmOn] = useState(existing?.rpm != null);
  const [rpm, setRpm] = useState(String(existing?.rpm ?? 60));
  const [allowlist, setAllowlist] = useState<string>(
    existing ? JSON.parse(existing.allowed_models || "[]").join(", ") : ""
  );
  const [err, setErr] = useState<string>();

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        label,
        limit_total: limitOn ? Number(limit) : null,
        rpm: rpmOn ? Number(rpm) : null,
        allowed_models: allowlist
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (existing) {
        body.enabled = !!existing.enabled;
        return api<KeyRow>(`/api/admin/keys/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
      return api<KeyRow>("/api/admin/keys", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (r) => onCreated(r as any),
    onError: (e: any) => setErr(e.message),
  });

  const LIMIT_UNITS = [
    { label: "10M", v: 10_000_000 },
    { label: "100M", v: 100_000_000 },
    { label: "1B", v: 1_000_000_000 },
    { label: "10B", v: 10_000_000_000 },
  ];

  return (
    <Modal open onClose={onClose} title={existing ? `Edit ${existing.label || "key"}` : "Create API key"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <Field label="Label">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="friend's laptop" autoFocus />
        </Field>

        <div className="rounded-lg border border-[var(--panel-edge)] bg-[var(--inset)] p-3">
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">Token budget</span>
            <Toggle checked={limitOn} onChange={setLimitOn} label="limit tokens" />
          </div>
          {limitOn && (
            <>
              <TextInput
                type="number"
                inputMode="numeric"
                min={1}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                aria-label="total token budget"
              />
              <div className="mt-1.5 flex gap-1.5">
                {LIMIT_UNITS.map((u) => (
                  <button
                    key={u.label}
                    type="button"
                    onClick={() => setLimit(String(u.v))}
                    className={`mono rounded-full border px-2 py-0.5 text-[11px] ${
                      limit === String(u.v)
                        ? "border-[var(--accent)] text-[var(--ink)]"
                        : "border-[var(--panel-edge)] text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                  >
                    {u.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                prompt + completion tokens count against this cumulative cap
              </p>
            </>
          )}
        </div>

        <div className="rounded-lg border border-[var(--panel-edge)] bg-[var(--inset)] p-3">
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
              Requests per minute
            </span>
            <Toggle checked={rpmOn} onChange={setRpmOn} label="rpm cap" />
          </div>
          {rpmOn && (
            <TextInput type="number" inputMode="numeric" min={1} value={rpm} onChange={(e) => setRpm(e.target.value)} aria-label="requests per minute" />
          )}
        </div>

        <Field label="Model allowlist" hint="empty = all models">
          <TextInput
            value={allowlist}
            onChange={(e) => setAllowlist(e.target.value)}
            placeholder="openai/gpt-5.2, anthropic/claude-sonnet-4.5"
          />
        </Field>

        <ErrorText>{err}</ErrorText>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {existing ? "Save changes" : "Create key"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
