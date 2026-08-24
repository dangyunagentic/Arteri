// Models — public_id mapping, thinking engine config (min/max budget, support), enable/disable.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Button, ErrorText, Field, Modal, Select, TextInput, Toggle } from "../ui";
import { fmt } from "./Overview";

interface Model {
  id: number;
  provider_id: number;
  provider_name: string;
  upstream_id: string;
  public_id: string;
  thinking_supported: number;
  min_thinking: number;
  max_thinking: number;
  enabled: number;
}

interface Provider {
  id: number;
  name: string;
}

const THINK_PRESETS = [
  { label: "off", supported: false },
  { label: "low (2k–16k)", supported: true, min: 1024, max: 16384 },
  { label: "medium (4k–32k)", supported: true, min: 4096, max: 32768 },
  { label: "high (8k–64k)", supported: true, min: 8192, max: 65536 },
  { label: "max (32k–256k)", supported: true, min: 32768, max: 262144 },
];

export default function Models() {
  const qc = useQueryClient();
  const { data: models } = useQuery({ queryKey: ["models"], queryFn: () => api<Model[]>("/api/admin/models") });
  const [editing, setEditing] = useState<Model | "new" | null>(null);

  const toggle = useMutation({
    mutationFn: (m: Model) =>
      api(`/api/admin/models/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          provider_id: m.provider_id,
          upstream_id: m.upstream_id,
          public_id: m.public_id,
          thinking_supported: !!m.thinking_supported,
          min_thinking: m.min_thinking,
          max_thinking: m.max_thinking,
          enabled: !m.enabled,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });

  const del = useMutation({
    mutationFn: (id: number) => api(`/api/admin/models/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });

  return (
    <>
      <header className="mb-5 flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Models</h1>
        <span className="text-sm text-[var(--muted)]">public id → upstream, thinking span per model</span>
        <Button variant="primary" className="ml-auto" onClick={() => setEditing("new")}>
          Add model
        </Button>
      </header>

      <div className="overflow-x-auto rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)]">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--panel-edge)] text-xs uppercase tracking-wider text-[var(--muted)]">
              <th className="px-4 py-2.5 font-medium">Public ID</th>
              <th className="px-3 py-2.5 font-medium">Upstream</th>
              <th className="px-3 py-2.5 font-medium">Provider</th>
              <th className="px-3 py-2.5 font-medium">Thinking</th>
              <th className="px-3 py-2.5 text-right font-medium">On</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(models ?? []).map((m) => (
              <tr key={m.id} className="border-t border-[var(--panel-edge)] first:border-t-0">
                <td className="mono px-4 py-2.5 text-[12.5px]">{m.public_id}</td>
                <td className="mono px-3 py-2.5 text-[12px] text-[var(--muted)]">{m.upstream_id}</td>
                <td className="px-3 py-2.5 text-[var(--muted)]">{m.provider_name}</td>
                <td className="px-3 py-2.5">
                  {m.thinking_supported ? (
                    <Badge tone="ok">
                      {fmt(m.min_thinking)}–{fmt(m.max_thinking)}
                    </Badge>
                  ) : (
                    <Badge>stripped</Badge>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Toggle
                    checked={!!m.enabled}
                    onChange={() => toggle.mutate(m)}
                    label={`toggle ${m.public_id}`}
                  />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setEditing(m)}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    className="ml-1.5 px-2 py-1 text-xs"
                    onClick={() => confirm(`Delete model '${m.public_id}'?`) && del.mutate(m.id)}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
            {models && models.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-[var(--faint)]">
                  no models — add one that maps a public id to a provider model
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && <ModelModal model={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ModelModal({ model, onClose }: { model: Model | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<Provider[]>("/api/admin/providers"),
  });
  const { data: discovered, isFetching: discovering, refetch } = useQuery({
    queryKey: ["discover", (model as any)?.provider_id ?? null],
    enabled: false,
    queryFn: () => api<{ ids: string[]; error?: string }>(`/api/admin/providers/${(model as any)?.provider_id}/models`),
  });
  const [form, setForm] = useState({
    provider_id: String(model?.provider_id ?? providers?.[0]?.id ?? ""),
    upstream_id: model?.upstream_id ?? "",
    public_id: model?.public_id ?? "",
    thinking_supported: !!model?.thinking_supported,
    min_thinking: String(model?.min_thinking ?? 1024),
    max_thinking: String(model?.max_thinking ?? 65536),
    enabled: !!model?.enabled || !model,
  });
  const [err, setErr] = useState<string>();

  const save = useMutation({
    mutationFn: () => {
      const body = {
        provider_id: Number(form.provider_id),
        upstream_id: form.upstream_id,
        public_id: form.public_id,
        thinking_supported: form.thinking_supported,
        min_thinking: Number(form.min_thinking) || 0,
        max_thinking: Number(form.max_thinking) || 0,
        enabled: form.enabled,
      };
      const url = model ? `/api/admin/models/${model.id}` : "/api/admin/models";
      return api(url, { method: model ? "PATCH" : "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      onClose();
    },
    onError: (e: any) => setErr(e.message),
  });

  const F = (k: keyof typeof form) => ({
    value: (form as any)[k] as string,
    onChange: (e: any) => setForm((f) => ({ ...f, [k]: e.target.value })),
  });

  return (
    <Modal open onClose={onClose} title={model ? `Edit ${model.public_id}` : "Add model"} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        <Field label="Provider">
          <Select {...F("provider_id")}>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Upstream model" hint="id the provider expects">
              <TextInput required {...F("upstream_id")} placeholder="gpt-5.2" />
            </Field>
          </div>
          <Button
            type="button"
            variant="ghost"
            disabled={!form.provider_id || discovering}
            onClick={() => refetch()}
            title="Fetch model list from the provider's /models endpoint"
          >
            {discovering ? "…" : "Fetch"}
          </Button>
        </div>
        {discovered && (
          <div className="sm:col-span-2">
            {discovered.ids.length > 0 ? (
              <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded border border-[var(--panel-edge)] bg-[var(--inset)] p-2">
                {discovered.ids.slice(0, 60).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="mono rounded bg-[var(--panel)] px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
                    onClick={() => setForm((f) => ({ ...f, upstream_id: id }))}
                  >
                    {id}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--faint)]">
                fetch returned nothing{discovered.error ? ` — ${discovered.error}` : ""}
              </p>
            )}
          </div>
        )}
        <Field label="Public ID" hint="what clients send as model">
          <TextInput required {...F("public_id")} placeholder="openai/gpt-5.2" />
        </Field>
        <Field label="Enabled">
          <div className="pt-1.5">
            <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} label="enabled" />
          </div>
        </Field>

        <div className="rounded-lg border border-[var(--panel-edge)] bg-[var(--inset)] p-3 sm:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
              Thinking engine
            </h3>
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <Toggle
                checked={form.thinking_supported}
                onChange={(v) => setForm((f) => ({ ...f, thinking_supported: v }))}
                label="thinking supported"
              />
              supported
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5 pb-3">
            {THINK_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    thinking_supported: p.supported,
                    ...(p.supported ? { min_thinking: String(p.min!), max_thinking: String(p.max!) } : {}),
                  }))
                }
                className={`mono rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  form.thinking_supported && p.supported && String(p.min) === form.min_thinking && String(p.max) === form.max_thinking
                    ? "border-[var(--accent)] text-[var(--ink)]"
                    : "border-[var(--panel-edge)] text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Min budget (tokens)" hint="requests below this get clamped up">
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                {...F("min_thinking")}
                disabled={!form.thinking_supported}
              />
            </Field>
            <Field label="Max budget (tokens)" hint="requests above this get clamped down">
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                {...F("max_thinking")}
                disabled={!form.thinking_supported}
              />
            </Field>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            clients may ask with reasoning_effort low…xhigh or Anthropic budget_tokens — Arteri normalizes
            both into this span. Unsupported models have every thinking field stripped.
          </p>
        </div>

        <ErrorText>{err}</ErrorText>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {model ? "Save changes" : "Add model"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
