import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { STATUS_LABELS, type VideoStatus } from "../api";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} />;
}

export function ErrorBox({ error, onClose }: { error?: string | null; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      <span>{error}</span>
      {onClose && (
        <button className="font-medium underline" onClick={onClose}>
          Dismiss
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
  idea: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  scripted: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ready: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  scheduled: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  published: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function StatusBadge({ status }: { status: VideoStatus }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function FormatBadge({ format }: { format: "short" | "long" }) {
  return (
    <span className="inline-block rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
      {format === "short" ? "Short" : "Long"}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="muted mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
