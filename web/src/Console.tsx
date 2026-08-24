// Console shell: sidebar nav + header with pulse dot. Guarded by useAuth.
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useAuth, api } from "./api";

const NAV = [
  { to: "/console", label: "Overview" },
  { to: "/console/providers", label: "Providers" },
  { to: "/console/models", label: "Models" },
  { to: "/console/keys", label: "API Keys" },
  { to: "/console/usage", label: "Usage" },
] as const;

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
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
  );
}

export default function Console() {
  const state = useAuth();
  const nav = useNavigate();
  if (state !== "ok") return null;
  return (
    <div className="flex min-h-screen">
      {/* sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col border-r border-[var(--panel-edge)] bg-[var(--panel)] max-lg:hidden">
        <Link to="/console" className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">Arteri</span>
        </Link>
        <nav className="mt-2 flex flex-col gap-0.5 px-3">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/console" }}
              activeProps={{ className: "nav-active" }}
              className="rounded-[var(--radius)] px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--inset)] hover:text-[var(--ink)] [&.nav-active]:bg-[var(--inset)] [&.nav-active]:text-[var(--ink)]"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto p-3">
          <button
            onClick={async () => {
              await api("/api/admin/logout", { method: "POST" });
              nav({ to: "/login" });
            }}
            className="w-full rounded-[var(--radius)] px-3 py-1.5 text-left text-sm text-[var(--faint)] transition-colors hover:bg-[var(--inset)] hover:text-[var(--ink)]"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-20 flex items-center gap-3 border-b border-[var(--panel-edge)] bg-[var(--panel)] px-4 py-3 lg:hidden">
        <Mark />
        <span className="font-semibold">Arteri</span>
        <nav className="ml-auto flex gap-1 overflow-x-auto">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeProps={{ className: "nav-active" }}
              className="whitespace-nowrap rounded-full border border-[var(--panel-edge)] px-2.5 py-1 text-xs text-[var(--muted)] [&.nav-active]:border-[var(--accent)] [&.nav-active]:text-[var(--ink)]"
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>

      <main className="min-w-0 flex-1 px-4 pb-16 pt-16 lg:ml-56 lg:px-8 lg:pt-8">
        <Outlet />
      </main>
    </div>
  );
}
