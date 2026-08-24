// Shared UI primitives — small, token-driven, no component library.
import { useEffect, useRef, useState, type ReactNode } from "react";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
          {label}
        </span>
        {hint && <span className="text-[11px] text-[var(--faint)]">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-[var(--radius)] border border-[var(--panel-edge)] bg-[var(--inset)] px-2.5 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--faint)] focus:border-[var(--accent)] focus-visible:outline-none";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${inputCls} appearance-none ${props.className ?? ""}`}>
      {props.children}
    </select>
  );
}

export function Button({
  variant = "ghost",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-[var(--accent)] text-white hover:bg-[var(--accent-dim)] active:bg-[var(--accent-dim)] border border-transparent",
    ghost:
      "bg-transparent text-[var(--ink)] hover:bg-[var(--panel-edge)] border border-[var(--panel-edge)]",
    danger:
      "bg-transparent text-[var(--red)] hover:bg-[rgba(217,45,32,.08)] border border-[rgba(217,45,32,.35)]",
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    />
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "err" | "accent";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "text-[var(--muted)] border-[var(--panel-edge)]",
    ok: "text-[var(--green)] border-[rgba(61,214,140,.35)]",
    warn: "text-[var(--amber)] border-[rgba(255,180,84,.35)]",
    err: "text-[var(--red)] border-[rgba(217,45,32,.4)]",
    accent: "text-[var(--blue)] border-[rgba(89,167,255,.35)]",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
        checked
          ? "border-transparent bg-[var(--accent)]"
          : "border-[var(--panel-edge)] bg-[var(--inset)]"
      }`}
    >
      <span
        className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all ${
          checked ? "left-[18px] bg-white" : "left-[3px] bg-[var(--faint)]"
        }`}
      />
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        className={`absolute inset-0`}
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-lg border border-[var(--panel-edge)] bg-[var(--panel)] p-5 shadow-2xl`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close" className="px-2 py-1 text-xs">
            esc
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="mt-2 rounded-[var(--radius)] border border-[rgba(217,45,32,.3)] bg-[rgba(217,45,32,.06)] px-2.5 py-1.5 text-xs text-[var(--red)]">
      {String(children)}
    </p>
  );
}

/** Copy-to-clipboard button with inline confirmation (no toast lib). */
export function CopyBtn({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // fallback for http contexts
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        clearTimeout(t.current);
        t.current = setTimeout(() => setDone(false), 1200);
      }}
      className="mono shrink-0 rounded border border-[var(--panel-edge)] px-1.5 py-0.5 text-[11px] text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--ink)]"
    >
      {done ? "copied" : label}
    </button>
  );
}
