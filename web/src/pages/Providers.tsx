// Providers — three catalog sections (OAuth / Free tier / API key) + connections.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ApiError } from "../api";
import { useOverlays } from "../toast";
import { Badge, Button, CopyBtn, ErrorText, Field, Modal, TextInput } from "../ui";

interface CatalogRow {
  id: string;
  name: string;
  protocol: string;
  category: "key" | "free" | "cloud" | "oauth";
  website: string | null;
  notice: string | null;
  has_models_fetch: boolean;
  connected_count: number;
}
interface OAuthCatalogRow {
  id: string;
  name: string;
  website: string | null;
  notice: string | null;
  supports_bulk: boolean;
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
  auth_type?: "apikey" | "oauth";
  email?: string;
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
  const oauthCatalog = useQuery({
    queryKey: ["oauth-catalog"],
    queryFn: () => api<OAuthCatalogRow[]>("/api/admin/oauth/catalog"),
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderRow[]>("/api/admin/providers"),
    refetchInterval: 15_000,
  });

  const [connectFor, setConnectFor] = useState<CatalogRow | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [openConn, setOpenConn] = useState<ProviderRow | null>(null);
  const [oauthFor, setOauthFor] = useState<OAuthCatalogRow | null>(null);

  const apiKeyProviders = (catalog.data ?? []).filter((e) => e.category === "key" || e.category === "cloud");
  const freeTierProviders = (catalog.data ?? []).filter((e) => e.category === "free");

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Providers</h1>
          <p className="text-sm text-[var(--muted)]">
            OAuth providers log in with your subscription account. Free tier and API key providers connect with a key. Multiple connections rotate round-robin.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setCustomOpen(true)}>
          Custom provider
        </Button>
      </header>

      {/* OAuth section */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">OAuth providers</h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          {(oauthCatalog.data ?? []).map((e) => {
            const conns = (providers.data ?? []).filter(
              (p) => p.catalog === e.id || p.slug.startsWith(e.id)
            );
            return (
              <div
                key={e.id}
                className="flex flex-col justify-between gap-2 rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--panel)] p-3"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{e.name}</span>
                    <Badge tone={conns.length > 0 ? "ok" : "muted"}>
                      {conns.length > 0 ? `${conns.length} connected` : "no connection"}
                    </Badge>
                  </div>
                  {conns.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {conns.slice(0, 3).map((p) => (
                        <div key={p.id} className="mono truncate text-[10px] text-[var(--faint)]">
                          · {p.email || p.name}
                        </div>
                      ))}
                      {conns.length > 3 && (
                        <div className="text-[10px] text-[var(--faint)]">+{conns.length - 3} more</div>
                      )}
                    </div>
                  )}
                  {e.notice && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--muted)]">{e.notice}</p>}
                </div>
                <Button onClick={() => setOauthFor(e)}>+ Connect account</Button>
              </div>
            );
          })}
          {oauthCatalog.isLoading && <div className="skeleton h-28" />}
        </div>
      </section>

      {/* Free tier section */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Free tier providers</h2>
        <CatalogGrid rows={freeTierProviders} onConnect={setConnectFor} />
      </section>

      {/* API key section */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">API key providers</h2>
        <CatalogGrid rows={apiKeyProviders} onConnect={setConnectFor} />
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
                  <th className="px-3 py-2 font-medium">Auth</th>
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
                      <Badge tone={p.auth_type === "oauth" ? "accent" : p.has_key ? "ok" : "warn"}>
                        {p.auth_type === "oauth" ? "oauth" : p.has_key ? "api key" : "missing"}
                      </Badge>
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
      {oauthFor && (
        <OAuthModal
          entry={oauthFor}
          onClose={() => setOauthFor(null)}
          onSaved={() => {
            setOauthFor(null);
            qc.invalidateQueries({ queryKey: ["providers"] });
          }}
        />
      )}
      {openConn && <ModelsDrawer conn={openConn} onClose={() => setOpenConn(null)} />}
    </div>
  );
}

// ---- catalog grid used by free-tier & api-key sections ----------------------

function CatalogGrid({
  rows,
  onConnect,
}: {
  rows: CatalogRow[];
  onConnect: (e: CatalogRow) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
      {rows.map((e) => (
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
            <div className="mt-0.5 text-[11px] text-[var(--faint)]">
              <span>{e.protocol}</span>
              {e.website && (
                <>
                  {" · "}
                  <a href={e.website} target="_blank" rel="noreferrer" className="link">
                    get key
                  </a>
                </>
              )}
            </div>
            {e.notice && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--muted)]">{e.notice}</p>}
          </div>
          <Button onClick={() => onConnect(e)}>+ Connect</Button>
        </div>
      ))}
    </div>
  );
}

// ---- OAuth connect modal: interactive PKCE + bulk import ---------------------

function OAuthModal({
  entry,
  onClose,
  onSaved,
}: {
  entry: OAuthCatalogRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useOverlays();
  const [tab, setTab] = useState<"interactive" | "bulk">("interactive");
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [bulkJson, setBulkJson] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // step 1: get the authorize URL
  const startFlow = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/oauth/${entry.id}/start`, { method: "POST" });
      if (!r.ok) throw new Error(((await r.json()) as ApiError).error?.message ?? `HTTP ${r.status}`);
      return r.json() as Promise<{ authorize_url: string }>;
    },
    onSuccess: (d) => setAuthorizeUrl(d.authorize_url),
    onError: (e) => setErr((e as Error).message),
  });

  // step 2: paste callback -> finish
  const finishFlow = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/oauth/${entry.id}/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_url: callbackUrl }),
      });
      if (!r.ok) throw new Error(((await r.json()) as ApiError).error?.message ?? `HTTP ${r.status}`);
      return r.json() as Promise<{ email?: string; slug?: string }>;
    },
    onSuccess: (d) => {
      toast(`Connected${d.email ? `: ${d.email}` : ""}`, "ok");
      onSaved();
    },
    onError: (e) => setErr((e as Error).message),
  });

  const bulkImport = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/oauth/${entry.id}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: bulkJson }),
      });
      if (!r.ok) throw new Error(((await r.json()) as ApiError).error?.message ?? `HTTP ${r.status}`);
      return r.json() as Promise<{ created: number }>;
    },
    onSuccess: (d) => {
      toast(`${d.created} account(s) imported`, "ok");
      onSaved();
    },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <Modal title={`Connect ${entry.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        {/* tabs */}
        <div className="flex rounded-full border border-[var(--panel-edge)] p-0.5 text-xs font-medium">
          <button
            className={`flex-1 rounded-full px-3 py-1.5 transition-colors ${
              tab === "interactive" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:bg-[var(--inset)]"
            }`}
            onClick={() => setTab("interactive")}
          >
            Interactive login
          </button>
          {entry.supports_bulk && (
            <button
              className={`flex-1 rounded-full px-3 py-1.5 transition-colors ${
                tab === "bulk" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:bg-[var(--inset)]"
              }`}
              onClick={() => setTab("bulk")}
            >
              Bulk import tokens
            </button>
          )}
        </div>

        {tab === "interactive" ? (
          <div className="space-y-3">
            {!authorizeUrl ? (
              <>
                <p className="text-sm leading-relaxed text-[var(--muted)]">
                  Arteri generates a PKCE login link using the same OAuth client as {entry.name}'s CLI. Open it, sign in,
                  then paste the redirected URL back here.
                </p>
                <ErrorText msg={err} />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button disabled={startFlow.isPending} onClick={() => startFlow.mutate()}>
                    {startFlow.isPending ? "Generating..." : "Generate login link"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Field label="Step 1 — open this link and sign in">
                  <div className="flex gap-2">
                    <TextInput readOnly value={authorizeUrl} onFocus={(e) => e.currentTarget.select()} />
                    <CopyBtn text={authorizeUrl} label="copy" />
                  </div>
                </Field>
                <Field label="Step 2 — paste the callback URL you were redirected to">
                  <TextInput
                    value={callbackUrl}
                    onChange={(e) => setCallbackUrl(e.target.value)}
                    placeholder="http://localhost:8787/api/admin/oauth/callback?code=...&state=..."
                  />
                </Field>
                <ErrorText msg={err} />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button disabled={!callbackUrl || finishFlow.isPending} onClick={() => finishFlow.mutate()}>
                    {finishFlow.isPending ? "Connecting..." : "Connect"}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              bulkImport.mutate();
            }}
            className="space-y-3"
          >
            <Field
              label="Accounts JSON"
              hint="Paste ~/.codex/auth.json content — a single object or an array with accessToken / refreshToken / email."
            >
              <textarea
                value={bulkJson}
                onChange={(e) => setBulkJson(e.target.value)}
                placeholder={`[\n  {\n    "accessToken": "...",\n    "refreshToken": "...",\n    "email": "user@example.com"\n  }\n]`}
                className="input mono h-48 resize-y text-xs"
              />
            </Field>
            <ErrorText msg={err} />
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!bulkJson.trim() || bulkImport.isPending}>
                {bulkImport.isPending ? "Importing..." : "Import All"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
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

function DeleteConnection({ id, onDone }: { id: number; onDone: () => void }) {
  const { confirm, toast } = useOverlays();
  const del = useMutation({
    mutationFn: async () => {
      await api(`/api/admin/providers/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      toast("Connection deleted");
      onDone();
    },
  });
  return (
    <button
      className="text-red-600 hover:underline"
      onClick={async () => {
        if (
          await confirm({
            title: "Delete connection?",
            body: "Its cached model list and enabled models are removed too. Combos referencing them stop resolving.",
          })
        )
          del.mutate();
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
