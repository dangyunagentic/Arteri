// Providers — 9Router-style catalog grid + per-connection model grid.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ApiError } from "../api";
import { Badge, Button, ErrorText, Modal, TextInput } from "../ui";

interface CatalogRow {
  id: string;
  name: string;
  protocol: string;
  category: "key" | "free" | "cloud";
  website: string | null;
  notice: string | null;
  has_models_fetch: boolean;
  connected_count: number;
}
interface ProviderRow {
  id: number;
  slug: string;
  name: string;
  catalog: string;
  base_url: string;
  protocol: string;
  has_key: boolean;
  model_count: number;
}
interface CachedModel {
  upstream_id: string;
  display_name: string;
  enabled: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  key: "API key",
  free: "Free tier",
  cloud: "Cloud",
};

export function ProvidersPage() {
  const qc = useQueryClient();
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<CatalogRow[]>("/api/admin/catalog"),
    refetchInterval: 15_000,
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderRow[]>("/api/admin/providers"),
    refetchInterval: 15_000,
  });

  const [connectFor, setConnectFor] = useState<CatalogRow | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [openConn, setOpenConn] = useState<ProviderRow | null>(null);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Providers</h1>
          <p className="text-sm text-[var(--muted)]">
            Connect an upstream once, then enable the models you want exposed. Multiple connections per provider rotate round-robin.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setCustomOpen(true)}>
          Custom provider
        </Button>
      </header>

      {/* catalog grid */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Catalog</h2>
        {catalog.isLoading ? (
          <div className="skeleton h-40 rounded-[var(--radius)]" />
        ) : (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
            {(catalog.data ?? []).map((e) => (
              <div
                key={e.id}
                className="flex flex-col justify-between gap-2 rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--panel)] p-3"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{e.name}</span>
                    <Badge tone={e.connected_count > 0 ? "ok" : "muted"}>
                      {e.connected_count > 0 ? `${e.connected_count} connected` : "no connection"}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--faint)]">
                    <span>{CATEGORY_LABEL[e.category] ?? e.category}</span>
                    <span>·</span>
                    <span>{e.protocol}</span>
                    {e.website && (
                      <>
                        <span>·</span>
                        <a href={e.website} target="_blank" rel="noreferrer" className="link">
                          get key
                        </a>
                      </>
                    )}
                  </div>
                  {e.notice && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--muted)]">{e.notice}</p>}
                </div>
                <Button onClick={() => setConnectFor(e)}>+ Connect</Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* connections */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Your connections</h2>
        {providers.data && providers.data.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-dashed border-[var(--panel-edge)] p-6 text-center text-sm text-[var(--muted)]">
            No connections yet — connect a provider above.
          </p>
        ) : (
          <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--panel-edge)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--inset)] text-left text-xs uppercase tracking-wide text-[var(--faint)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Connection</th>
                  <th className="px-3 py-2 font-medium">Slug</th>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Models</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(providers.data ?? []).map((p) => (
                  <tr key={p.id} className="border-t border-[var(--panel-edge)]">
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="mono px-3 py-2 text-xs text-[var(--muted)]">{p.slug}</td>
                    <td className="px-3 py-2">
                      <Badge tone={p.has_key ? "ok" : "warn"}>{p.has_key ? "set" : "missing"}</Badge>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{p.model_count}</td>
                    <td className="px-3 py-2 text-right">
                      <button className="link mr-3" onClick={() => setOpenConn(p)}>
                        Models
                      </button>
                      <DeleteConnection id={p.id} onDone={() => qc.invalidateQueries({ queryKey: ["providers"] })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {connectFor && (
        <ConnectModal
          entry={connectFor}
          onClose={() => setConnectFor(null)}
          onSaved={() => {
            setConnectFor(null);
            qc.invalidateQueries({ queryKey: ["providers"] });
            qc.invalidateQueries({ queryKey: ["catalog"] });
          }}
        />
      )}
      {customOpen && (
        <CustomModal
          onClose={() => setCustomOpen(false)}
          onSaved={() => {
            setCustomOpen(false);
            qc.invalidateQueries({ queryKey: ["providers"] });
          }}
        />
      )}
      {openConn && <ModelsDrawer conn={openConn} onClose={() => setOpenConn(null)} />}
    </div>
  );
}

function ConnectModal({ entry, onClose, onSaved }: { entry: CatalogRow; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/providers/connect", {
        method: "POST",
        headers: { "content-type": "application/json", ...(document.cookie.includes("arteri_admin") ? {} : {}) },
        body: JSON.stringify({ catalog: entry.id, api_key: key }),
      });
      if (!r.ok) throw new Error(((await r.json()) as ApiError).error?.message ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: onSaved,
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <Modal title={`Connect ${entry.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate();
        }}
        className="space-y-3"
      >
        <Field label="API key" hint={entry.notice ?? undefined}>
          <TextInput value={key} onChange={(e) => setKey(e.target.value)} placeholder={entry.protocol === "anthropic" ? "sk-ant-..." : "sk-..."} autoFocus />
        </Field>
        <ErrorText msg={err} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? "Connecting..." : "Connect"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CustomModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState("openai");
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/providers/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog: "custom", name, base_url: baseUrl, api_key: apiKey, protocol }),
      });
      if (!r.ok) throw new Error(((await r.json()) as ApiError).error?.message ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: onSaved,
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <Modal title="Custom provider" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="space-y-3"
      >
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="My gateway" autoFocus />
        </Field>
        <Field label="Base URL">
          <TextInput value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://host/v1" />
        </Field>
        <Field label="API key">
          <TextInput value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="optional for open endpoints" />
        </Field>
        <Field label="Protocol">
          <select className="input" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </Field>
        <ErrorText msg={err} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !name || !baseUrl}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-snug text-[var(--faint)]">{hint}</span>}
    </label>
  );
}

function DeleteConnection({ id, onDone }: { id: number; onDone: () => void }) {
  const del = useMutation({
    mutationFn: async () => {
      await api(`/api/admin/providers/${id}`, { method: "DELETE" });
    },
    onSuccess: onDone,
  });
  return (
    <button
      className="text-red-600 hover:underline"
      onClick={() => {
        if (confirm("Delete this connection and its cached models?")) del.mutate();
      }}
    >
      Delete
    </button>
  );
}

// ---- per-connection model grid ---------------------------------------------

function ModelsDrawer({ conn, onClose }: { conn: ProviderRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cached = useQuery({
    queryKey: ["cached-models", conn.id],
    queryFn: () => api<CachedModel[]>(`/api/admin/providers/${conn.id}/cached-models`),
    refetchInterval: 5000,
  });
  const fetchModels = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/providers/${conn.id}/fetch-models`, { method: "POST" });
      if (!r.ok) throw new Error(((await r.json()) as any).error?.message ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cached-models", conn.id] });
      qc.invalidateQueries({ queryKey: ["providers"] });
      setErr(null);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const toggle = useMutation({
    mutationFn: async (m: CachedModel) => {
      await api(`/api/admin/providers/${conn.id}/models/toggle`, {
        method: "POST",
        body: JSON.stringify({ upstream_id: m.upstream_id, enabled: !m.enabled }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cached-models", conn.id] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });

  const list = (cached.data ?? []).filter(
    (m) =>
      !filter ||
      m.upstream_id.toLowerCase().includes(filter.toLowerCase()) ||
      m.display_name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <Modal title={`${conn.name} — models`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <TextInput
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter models..."
            className="max-w-xs"
          />
          <Button variant="secondary" disabled={fetchModels.isPending} onClick={() => fetchModels.mutate()}>
            {fetchModels.isPending ? "Fetching..." : "Fetch latest"}
          </Button>
        </div>
        <p className="text-[11px] text-[var(--faint)]">
          Enabled models are served as <span className="mono">{conn.slug}/&lt;model&gt;</span>. Toggle pulls straight from the cache — hit “Fetch latest” to pull newly released models from the provider.
        </p>
        <ErrorText msg={err} />
        {cached.isLoading ? (
          <div className="skeleton h-64" />
        ) : list.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-dashed border-[var(--panel-edge)] p-6 text-center text-sm text-[var(--muted)]">
            Cache empty — press “Fetch latest” to pull the model list from {conn.name}.
          </p>
        ) : (
          <div className="grid max-h-[50vh] grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2 xl:grid-cols-3">
            {list.map((m) => (
              <button
                key={m.upstream_id}
                onClick={() => toggle.mutate(m)}
                className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                  m.enabled
                    ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
                    : "border-[var(--panel-edge)] bg-[var(--panel)] hover:bg-[var(--inset)]"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{m.display_name || m.upstream_id}</span>
                  <span className="mono block truncate text-[10px] text-[var(--faint)]">{m.upstream_id}</span>
                </span>
                <span className={`shrink-0 text-[10px] font-semibold ${m.enabled ? "text-emerald-700" : "text-[var(--faint)]"}`}>
                  {m.enabled ? "ON" : "off"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function ProvidersDefault() {
  return <ProvidersPage />;
}
