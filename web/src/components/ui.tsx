import { useState, type ReactNode } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { STATUS_LABELS, type VideoStatus } from "../api";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin text-pink-500`} />;
}

export function ErrorBox({ error, onClose }: { error?: string | null; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-500/30 bg-red-950/40 p-4 text-sm text-red-200 backdrop-blur-md shadow-[0_4px_20px_rgba(255,0,0,0.15)]">
      <div className="flex items-center gap-2.5">
        <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
        <span>{error}</span>
      </div>
      {onClose && (
        <button className="text-red-400 transition hover:text-red-200" onClick={onClose} aria-label="Dismiss">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** Wraps an async action with a busy flag and error message. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, run };
}

const STATUS_STYLES: Record<VideoStatus, string> = {
  idea: "border-purple-500/30 bg-purple-500/10 text-purple-300 shadow-[0_0_12px_rgba(168,85,247,0.15)]",
  scripted: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.15)]",
  ready: "border-amber-500/30 bg-amber-500/10 text-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.15)]",
  scheduled: "border-pink-500/30 bg-pink-500/10 text-pink-300 shadow-[0_0_12px_rgba(255,0,153,0.15)]",
  published: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.15)]",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-300 shadow-[0_0_12px_rgba(244,63,94,0.15)]",
};

export function StatusBadge({ status }: { status: VideoStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide ${STATUS_STYLES[status]}`}>
      <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function FormatBadge({ format }: { format: "short" | "long" }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 text-xs font-medium text-zinc-300">
      {format === "short" ? "📱 Short (9:16)" : "🎬 Long (16:9)"}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight text-white md:text-3xl">{title}</h1>
        {subtitle && <p className="muted mt-1 text-sm text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  );
}
