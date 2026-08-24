import { Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json", ...(init?.headers ?? {}) }
        : init?.headers,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j?.error?.message ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** Auth gate for the console shell — checks session, redirects to /login. */
export function useAuth() {
  const [state, setState] = useState<"checking" | "ok" | "no">("checking");
  const nav = useNavigate();
  useEffect(() => {
    api<{ authenticated: boolean }>("/api/admin/session")
      .then((r) => {
        if (r.authenticated) setState("ok");
        else {
          setState("no");
          nav({ to: "/login" });
        }
      })
      .catch(() => {
        setState("no");
        nav({ to: "/login" });
      });
  }, [nav]);
  return state;
}
