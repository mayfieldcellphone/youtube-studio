import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { ErrorBox, Spinner, useAction } from "./ui";
import SnapgenCard from "./SnapgenCard";

interface Budget {
  cap: number;
  spent: number;
  month: string;
  /** A budget was saved on the Setup page; otherwise the app's default applies. */
  saved: boolean;
}

type SettingsReply = Record<string, { set?: boolean; value?: string; cap?: string; month?: string } | undefined>;

const toBudget = (data: SettingsReply): Budget => ({
  cap: Number(data.AI_FOOTAGE_SPENT_USD?.cap ?? 0),
  spent: Number(data.AI_FOOTAGE_SPENT_USD?.value ?? 0),
  month: data.AI_FOOTAGE_SPENT_USD?.month ?? "",
  saved: Boolean(data.AI_FOOTAGE_MONTHLY_CAP_USD?.set),
});

async function call(method: "GET" | "PUT", body?: unknown): Promise<SettingsReply> {
  const res = await fetch("/api/settings", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The SnapGen video key box, then this month's AI footage (Google Veo backup) spend against a
 * budget the app enforces on its own.
 */
export default function AiBudgetCard() {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    call("GET")
      .then((data) => setBudget(toBudget(data)))
      .catch((e) => setError(e.message));
  }, [setError]);

  const save = (amount: string) =>
    run("save", async () => {
      const amountNumber = Number(amount.replace(/^\$/, ""));
      if (amount.trim() && (!Number.isFinite(amountNumber) || amountNumber < 0)) throw new Error("Enter the budget as a number of dollars, like 40.");
      setBudget(toBudget(await call("PUT", { AI_FOOTAGE_MONTHLY_CAP_USD: amount.trim() })));
      setValue("");
      setSaved(true);
    });

  const share = budget && budget.cap > 0 ? budget.spent / budget.cap : budget ? 1 : 0;

  return (
    <>
      <SnapgenCard />
      <section className="card text-sm">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          2a++. AI footage budget (Google Veo backup)
          {budget && (
            <span className={`text-xs font-normal ${share > 0.85 ? "text-red-500" : "text-green-600"}`}>
              {usd(budget.spent)} of {usd(budget.cap)} used this month
            </span>
          )}
        </h2>
        <p className="mb-3 text-xs text-zinc-400">
          The app keeps Google Veo footage (your Gemini key) inside this monthly budget by itself. SnapGen clips are paid in your SnapGen
          credits and are not counted here. The opening hook and key moments use Veo Fast; filler shots use the cheaper Veo Lite; the
          expensive Quality model is used for the hook only on channels set to "Best quality". When the budget is low, shots move to
          Lite, and when it is spent the rest use stock footage (the video notes say so). It resets each calendar month.
        </p>
        {!budget && !error && <Spinner />}
        {budget && (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div className={`h-full ${share > 0.85 ? "bg-red-600" : "bg-green-600"}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {budget.month} · {budget.saved ? "your budget" : "default budget, change it below"} · about {usd(8 * 0.15)} per Fast clip and {usd(8 * 0.08)} per Lite clip
            </p>
            <form
              className="mt-3 flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSaved(false);
                save(value);
              }}
            >
              <span className="text-zinc-400">$</span>
              <input
                className="w-28"
                inputMode="decimal"
                autoComplete="off"
                placeholder={String(budget.cap)}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <span className="text-zinc-400">per month</span>
              <button className="btn-primary" disabled={busy === "save" || !value.trim()}>
                {busy === "save" && <Spinner />} Save budget
              </button>
              {budget.saved && (
                <button type="button" className="btn-ghost" disabled={busy === "save"} onClick={() => save("")}>
                  Use default
                </button>
              )}
              {saved && !error && (
                <span className="flex items-center gap-1 text-xs text-green-600">
                  <Check className="h-3.5 w-3.5" /> Saved
                </span>
              )}
            </form>
            <p className="mt-2 text-xs text-zinc-500">Enter 0 to switch AI footage off completely (SnapGen too); videos then use stock footage.</p>
          </>
        )}
        <ErrorBox error={error} onClose={() => setError(null)} />
      </section>
    </>
  );
}
