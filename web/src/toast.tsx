// Overlay system — toasts + promise-based confirm dialog. No libraries.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Tone = "ok" | "err" | "info";
interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}
export interface ConfirmOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean; // default true -> red confirm button
}

const Ctx = createContext<{
  toast: (text: string, tone?: Tone) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
} | null>(null);

export function useOverlays() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOverlays outside <Overlays>");
  return v;
}

const TONE_BAR: Record<Tone, string> = {
  ok: "border-l-emerald-500",
  err: "border-l-red-500",
  info: "border-l-blue-500",
};
const TONE_ICON: Record<Tone, string> = {
  ok: "✓",
  err: "✕",
  info: "i",
};
const TONE_ICON_CLS: Record<Tone, string> = {
  ok: "bg-emerald-50 text-emerald-600",
  err: "bg-red-50 text-red-600",
  info: "bg-blue-50 text-blue-600",
};

export function Overlays({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const [dialog, setDialog] = useState<(ConfirmOpts & { resolve: (b: boolean) => void }) | null>(null);

  const toast = useCallback((text: string, tone: Tone = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-4), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setDialog({ danger: true, ...opts, resolve })),
    []
  );

  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
  };

  useEffect(() => {
    if (!dialog) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && close(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dialog]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}

      {/* confirm dialog */}
      {dialog && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[3px] animate-fade"
          onMouseDown={() => close(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={dialog.title}
            onMouseDown={(e) => e.stopPropagation()}
            className="animate-pop w-full max-w-sm rounded-2xl border border-[var(--panel-edge)] bg-[var(--panel)] p-5 shadow-2xl"
          >
            <h2 className="text-[15px] font-semibold tracking-tight">{dialog.title}</h2>
            {dialog.body && <p className="mt-1.5 text-sm leading-relaxed text-[var(--muted)]">{dialog.body}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg border border-[var(--panel-edge)] px-3.5 py-1.5 text-sm font-medium hover:bg-[var(--inset)]"
                onClick={() => close(false)}
                autoFocus
              >
                {dialog.cancelLabel ?? "Cancel"}
              </button>
              <button
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium text-white ${
                  dialog.danger ? "bg-red-600 hover:bg-red-700 active:bg-red-800" : "bg-[var(--accent)] hover:bg-[var(--accent-dim)]"
                }`}
                onClick={() => close(true)}
              >
                {dialog.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* toast stack */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`animate-slide-in pointer-events-auto flex items-start gap-2.5 rounded-xl border border-[var(--panel-edge)] border-l-4 bg-[var(--panel)] py-2.5 pl-2.5 pr-3 shadow-lg ${TONE_BAR[t.tone]}`}
          >
            <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${TONE_ICON_CLS[t.tone]}`}>
              {TONE_ICON[t.tone]}
            </span>
            <p className="text-sm leading-snug">{t.text}</p>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
