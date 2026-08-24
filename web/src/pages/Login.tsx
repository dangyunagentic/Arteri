import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../api";
import { Button, ErrorText, Field, TextInput } from "../ui";

export default function Login() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      nav({ to: "/console" });
    } catch (e: any) {
      setErr(e.message ?? "login failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <svg width="44" height="44" viewBox="0 0 32 32" className="mx-auto mb-3" aria-hidden>
            <rect width="32" height="32" rx="7" fill="var(--panel-edge)" />
            <path
              d="M6 22 Q14 22 16 16 T26 10"
              stroke="var(--accent)"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
            <circle cx="26" cy="10" r="3" fill="var(--accent)" />
          </svg>
          <h1 className="text-lg font-semibold tracking-tight">Arteri console</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Sign in to manage the router.</p>
        </div>
        <form onSubmit={submit} className="rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] p-5">
          <Field label="Password">
            <TextInput
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="admin password"
            />
          </Field>
          <ErrorText>{err}</ErrorText>
          <Button variant="primary" type="submit" disabled={busy || !password} className="mt-4 w-full justify-center">
            {busy ? "Checking…" : "Sign in"}
          </Button>
        </form>
        <p className="mono mt-4 text-center text-[11px] leading-relaxed text-[var(--faint)]">
          generated password prints once on first boot
          <br />
          or set ADMIN_PASSWORD in .env
        </p>
      </div>
    </div>
  );
}
