export type VideoStatus = "idea" | "scripted" | "ready" | "scheduled" | "published" | "failed";
export type VideoFormat = "short" | "long";

export interface Channel {
  id: string;
  name: string;
  niche: string;
  audience: string;
  tone: string;
  language: string;
  postingDays: number[];
  postingTime: string;
  categoryId: string;
  youtube?: { channelId: string; title: string; thumbnail?: string; connectedAt: string };
  stats?: { subscribers: number; views: number; videos: number; updatedAt: string };
  createdAt: string;
}

export interface FileInfo {
  name: string;
  size: number;
  mimeType: string;
}

export interface Video {
  id: string;
  channelId: string;
  status: VideoStatus;
  format: VideoFormat;
  title: string;
  hook: string;
  keyword: string;
  angle: string;
  script: string;
  titleOptions: string[];
  description: string;
  tags: string[];
  videoFile?: FileInfo;
  thumbnailFile?: FileInfo;
  scheduledAt?: string;
  youtubeVideoId?: string;
  error?: string;
  stats?: { views: number; likes: number; comments: number; updatedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface Status {
  loggedIn: boolean;
  passwordRequired: boolean;
  ai: boolean;
  youtube: boolean;
  redirectUri: string;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  status: () => request<Status>("GET", "/api/status"),
  login: (password: string) => request("POST", "/api/login", { password }),
  logout: () => request("POST", "/api/logout"),

  channels: () => request<Channel[]>("GET", "/api/channels"),
  createChannel: (c: Partial<Channel>) => request<Channel>("POST", "/api/channels", c),
  updateChannel: (id: string, c: Partial<Channel>) => request<Channel>("PATCH", `/api/channels/${id}`, c),
  deleteChannel: (id: string) => request("DELETE", `/api/channels/${id}`),
  generateIdeas: (id: string, count: number, focus?: string) =>
    request<Video[]>("POST", `/api/channels/${id}/ideas`, { count, focus: focus || undefined }),
  syncChannel: (id: string) => request<Channel>("POST", `/api/channels/${id}/sync`),
  disconnectYouTube: (id: string) => request<Channel>("POST", `/api/channels/${id}/youtube/disconnect`),
  connectYouTubeUrl: (id: string) => `/api/channels/${id}/youtube/connect`,

  videos: (channelId?: string) =>
    request<Video[]>("GET", channelId ? `/api/videos?channelId=${channelId}` : "/api/videos"),
  video: (id: string) => request<Video>("GET", `/api/videos/${id}`),
  createVideo: (v: { channelId: string; title: string; format: VideoFormat }) =>
    request<Video>("POST", "/api/videos", v),
  updateVideo: (id: string, v: Partial<Omit<Video, "scheduledAt">> & { scheduledAt?: string | null }) =>
    request<Video>("PATCH", `/api/videos/${id}`, v),
  deleteVideo: (id: string) => request("DELETE", `/api/videos/${id}`),
  generateScript: (id: string) => request<Video>("POST", `/api/videos/${id}/script`),
  generateMetadata: (id: string) => request<Video>("POST", `/api/videos/${id}/metadata`),
  uploadFile: (id: string, kind: "video" | "thumbnail", file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Video>("POST", `/api/videos/${id}/files/${kind}`, form);
  },
  thumbnailUrl: (v: Video) => `/api/videos/${v.id}/thumbnail?t=${encodeURIComponent(v.updatedAt)}`,
  publish: (id: string) => request<Video & { uploading: boolean }>("POST", `/api/videos/${id}/publish`),
  uploading: () => request<string[]>("GET", "/api/uploads"),
};

export const STATUS_LABELS: Record<VideoStatus, string> = {
  idea: "Idea",
  scripted: "Scripted",
  ready: "Ready to post",
  scheduled: "Scheduled",
  published: "Published",
  failed: "Upload failed",
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** YouTube video categories most useful for monetized channels. */
export const CATEGORIES: [string, string][] = [
  ["22", "People & Blogs"],
  ["28", "Science & Technology"],
  ["27", "Education"],
  ["26", "Howto & Style"],
  ["24", "Entertainment"],
  ["20", "Gaming"],
  ["17", "Sports"],
  ["10", "Music"],
  ["2", "Autos & Vehicles"],
  ["19", "Travel & Events"],
  ["25", "News & Politics"],
  ["23", "Comedy"],
];

/** The next posting slot on the channel's schedule that no other video already uses. */
export function nextSlot(channel: Channel, videos: Video[], from = new Date()): Date {
  const [h, m] = channel.postingTime.split(":").map(Number);
  const days = channel.postingDays.length ? channel.postingDays : [0, 1, 2, 3, 4, 5, 6];
  const taken = new Set(
    videos.filter((v) => v.scheduledAt && v.channelId === channel.id).map((v) => new Date(v.scheduledAt!).toDateString()),
  );
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  // Start at least 30 minutes out so YouTube has time to process the upload.
  const earliest = from.getTime() + 30 * 60 * 1000;
  for (let i = 0; i < 366; i++) {
    if (days.includes(d.getDay()) && d.getTime() > earliest && !taken.has(d.toDateString())) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** Formats a Date for an <input type="datetime-local">. */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);

export const fileSize = (bytes: number) =>
  bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
