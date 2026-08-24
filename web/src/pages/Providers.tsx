// Providers — CRUD upstreams (base_url + api_key + protocol). Keys are write-only.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput } from "../ui";

interface Provider {
  id: number;
  slug: string;
  name: string;
  base_url: string;
  protocol: "openai" | "anthropic";
  extra_headers: string;
  model_count: number;
  has_key: boolean;
  created_at: number;
}

const PRESETS = [
  { name: "OpenAI", base_url: "https://api.openai.com/v1", protocol: "openai" },
  { name: "Anthropic", base_url: "https://api.anthropic.com", protocol: "anthropic" },
  { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", protocol: "openai" },
  { name: "Groq", base_url: "https://api.groq.com/openai/v1", protocol: "openai" },
  { name: "DeepSeek", base_url: "https://api.deepseek.com/v1", protocol: "openai" },
  { name: "Gemini (OpenAI-compat)", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", protocol: "openai" },
  { name: "Ollama", base_url: "http://localhost:11434/v1", protocol: "openai" },
];

export default function Providers() {
  const qc = useQueryClient();
  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<Provider[]>("/api/admin/providers"),
  });
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [err, setErr] = useState<string>();

  const del = useMutation({
    mutationFn: (id: number) => api(`/api/admin/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
  });

  return (
    <>
      <header className="mb-5 flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Providers</h1>
        <span className="text-sm text-[var(--muted)]">upstreams with custom base URL + API key</span>
        <Button variant="primary" className="ml-auto" onClick={() => { setErr(undefined); setEditing("new"); }}>
          Add provider
        </Button>
      </header>

      <div className="overflow-x-auto rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)]">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--panel-edge)] text-xs uppercase tracking-wider text-[var(--muted)]">
              <th className="px-4 py-2.5 font-medium">Provider</th>
              <th className="px-3 py-2.5 font-medium">Base URL</th>
              <th className="px-3 py-2.5 font-medium">Protocol</th>
              <th className="px-3 py-2.5 font-medium">Key</th>
              <th className="px-3 py-2.5 font-medium">Models</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(providers ?? []).map((p) => (
              <tr key={p.id} className="border-t border-[var(--panel-edge)] first:border-t-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{p.name}</div>
                  <div className="mono text-[11px] text-[var(--faint)]">{p.slug}</div>
                </td>
                <td className="mono max-w-[280px] truncate px-3 py-2.5 text-[12px] text-[var(--muted)]">
                  {p.base_url}
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone={p.protocol === "anthropic" ? "warn" : "accent"}>{p.protocol}</Badge>
                </td>
                <td className="px-3 py-2.5">
                  {p.has_key ? <Badge tone="ok">set</Badge> : <Badge>none</Badge>}
                </td>
                <td className="mono px-3 py-2.5 text-[12px]">{p.model_count}</td>
                <td className="px-4 py-2.5 text-right">
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs"
                    onClick={() => { setErr(undefined); setEditing(p); }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    className="ml-1.5 px-2 py-1 text-xs"
                    onClick={() => {
                      if (confirm(`Delete provider '${p.name}'? Its models are removed too.`))
                        del.mutate(p.id);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
            {providers && providers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-[var(--faint)]">
                  no providers yet — add one to start routing
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <ProviderModal
          provider={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onError={setErr}
        />
      )}
      <ErrorText>{err}</ErrorText>
    </>
  );
}

function ProviderModal({
  provider,
  onClose,
  onError,
}: {
  provider: Provider | null;
  onClose: () => void;
  onError: (s?: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState(provider?.protocol ?? "openai");
  const [extra, setExtra] = useState(
    provider && provider.extra_headers !== "{}" ? provider.extra_headers : ""
  );

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name,
        base_url: baseUrl,
        protocol,
        extra_headers: extra.trim() ? JSON.parse(extra) : {},
      };
      if (apiKey.trim()) body.api_key = apiKey.trim();
      if (!provider) body.api_key = apiKey.trim();
      const url = provider ? `/api/admin/providers/${provider.id}` : "/api/admin/providers";
      return api(url, { method: provider ? "PATCH" : "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      onClose();
    },
    onError: (e: any) => onError(e.message),
  });

  return (
    <Modal open onClose={onClose} title={provider ? `Edit ${provider.name}` : "Add provider"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        {!provider && (
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => {
                  setName(p.name);
                  setBaseUrl(p.base_url);
                  setProtocol(p.protocol as any);
                }}
                className="mono rounded-full border border-[var(--panel-edge)] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--ink)]"
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <Field label="Name">
          <TextInput required value={name} onChange={(e) => setName(e.target.value)} placeholder="My provider" />
        </Field>
        <Field label="Base URL" hint="OpenAI-compatible: …/v1 · Anthropic: origin only">
          <TextInput
            required
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field label="API key" hint={provider ? "leave empty to keep current" : undefined}>
          <TextInput
            required={!provider}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider && provider.has_key ? "•••• stored" : "sk-…"}
          />
        </Field>
        <Field label="Protocol">
          <Select value={protocol} onChange={(e) => setProtocol(e.target.value as any)}>
            <option value="openai">OpenAI chat completions</option>
            <option value="anthropic">Anthropic messages</option>
          </Select>
        </Field>
        <Field label="Extra headers" hint='optional JSON, e.g. {"HTTP-Referer":"https://x.dev"}'>
          <TextInput value={extra} onChange={(e) => setExtra(e.target.value)} placeholder='{"X-Title":"arteri"}' />
        </Field>
        <ErrorText>{save.error ? (save.error as Error).message : undefined}</ErrorText>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {provider ? "Save changes" : "Add provider"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
