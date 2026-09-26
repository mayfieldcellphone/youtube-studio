import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, DAY_NAMES, type Video } from "../api";
import { useApp } from "../App";
import { ErrorBox, PageHeader, StatusBadge } from "../components/ui";

const WEEKS = 5;

export default function Calendar() {
  const { channels } = useApp();
  const [videos, setVideos] = useState<Video[]>([]);
  const [offset, setOffset] = useState(0);
  const [channelFilter, setChannelFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.videos().then(setVideos).catch((e) => setError(e.message));
  }, []);

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + offset * 7 * WEEKS);
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });

  const shown = videos.filter((v) => v.scheduledAt && (!channelFilter || v.channelId === channelFilter));
  const channelIndex = (id: string) => channels.findIndex((c) => c.id === id);
  const today = new Date().toDateString();
  const postingDay = (d: Date) =>
    channels.some((c) => (!channelFilter || c.id === channelFilter) && c.postingDays.includes(d.getDay()));

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Planned, scheduled and published videos. Dashed days are your posting days."
        actions={
          <>
            <select className="w-auto" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button className="btn-secondary" onClick={() => setOffset(offset - 1)} aria-label="Earlier">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button className="btn-secondary" onClick={() => setOffset(0)}>Today</button>
            <button className="btn-secondary" onClick={() => setOffset(offset + 1)} aria-label="Later">
              <ChevronRight className="h-4 w-4" />
            </button>
          </>
        }
      />
      <ErrorBox error={error} />

      <div className="hidden grid-cols-7 gap-2 pb-2 text-center text-xs font-medium text-zinc-500 md:grid">
        {DAY_NAMES.map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="grid gap-2 md:grid-cols-7">
        {days.map((d) => {
          const items = shown.filter((v) => new Date(v.scheduledAt!).toDateString() === d.toDateString());
          const isToday = d.toDateString() === today;
          if (!items.length && !isToday && typeof window !== "undefined" && window.innerWidth < 768) return null;
          return (
            <div
              key={d.toISOString()}
              className={`min-h-24 rounded-lg border p-2 ${
                isToday ? "border-red-400 bg-red-50/50 dark:bg-red-950/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
              } ${postingDay(d) && !items.length ? "border-dashed" : ""}`}
            >
              <div className="mb-1 text-xs text-zinc-500">
                <span className="md:hidden">{DAY_NAMES[d.getDay()]} </span>
                {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </div>
              <div className="space-y-1">
                {items.map((v) => (
                  <a
                    key={v.id}
                    href={`#/videos/${v.id}`}
                    className="block rounded border-l-4 bg-zinc-50 px-2 py-1 text-xs hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                    style={{ borderLeftColor: COLORS[channelIndex(v.channelId) % COLORS.length] }}
                    title={channels[channelIndex(v.channelId)]?.name}
                  >
                    <p className="line-clamp-2 font-medium">{v.title}</p>
                    <div className="mt-1 flex items-center gap-1 text-zinc-500">
                      {new Date(v.scheduledAt!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      <StatusBadge status={v.status} />
                    </div>
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {channels.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-zinc-500">
          {channels.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} /> {c.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const COLORS = ["#dc2626", "#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
