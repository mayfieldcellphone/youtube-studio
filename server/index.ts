import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db, publicChannel, publicVideo, UPLOAD_DIR, type Video } from "./db";
import { aiConfigured, generateIdeas, generateMetadata, generateScript } from "./ai";
import { authUrl, completeAuth, redirectUri, syncChannel, uploadAndSchedule, youtubeConfigured } from "./youtube";

const PORT = Number(process.env.PORT ?? 3000);
const PROD = process.env.NODE_ENV === "production";
const PASSWORD = process.env.APP_PASSWORD ?? "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(SECRET));

// ---------- Login ----------

const cookieOpts = { signed: true, httpOnly: true, sameSite: "lax" as const, secure: PROD };

function sameText(a: string, b: string) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loggedIn = (req: Request) => !PASSWORD || req.signedCookies.session === "ok";

app.get("/api/status", (req, res) => {
  res.json({
    loggedIn: loggedIn(req),
    passwordRequired: Boolean(PASSWORD),
    ai: aiConfigured(),
    youtube: youtubeConfigured(),
    redirectUri: redirectUri(),
  });
});

app.post("/api/login", (req, res) => {
  const password = String(req.body?.password ?? "");
  if (!PASSWORD || sameText(password, PASSWORD)) {
    res.cookie("session", "ok", { ...cookieOpts, maxAge: 30 * 24 * 3600 * 1000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Wrong password." });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (loggedIn(req)) return next();
  res.status(401).json({ error: "Please log in." });
});

// ---------- Helpers ----------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function getChannel(id: string) {
  const channel = db.channel(id);
  if (!channel) throw new HttpError(404, "Channel not found.");
  return channel;
}

function getVideo(id: string) {
  const video = db.video(id);
  if (!video) throw new HttpError(404, "Video not found.");
  return video;
}

function requireAi() {
  if (!aiConfigured()) throw new HttpError(400, "Add ANTHROPIC_API_KEY to your .env file to use AI features.");
}

// ---------- Channels ----------

const channelInput = z.object({
  name: z.string().trim().min(1).max(100),
  niche: z.string().trim().min(1).max(500),
  audience: z.string().trim().max(500).default(""),
  tone: z.string().trim().max(200).default(""),
  language: z.string().trim().max(50).default("English"),
  postingDays: z.array(z.number().int().min(0).max(6)).default([1, 3, 5]),
  postingTime: z.string().regex(/^\d{2}:\d{2}$/).default("17:00"),
  categoryId: z.string().regex(/^\d+$/).default("22"),
});

app.get("/api/channels", (_req, res) => {
  res.json(db.channels().map(publicChannel));
});

app.post("/api/channels", (req, res) => {
  res.json(publicChannel(db.createChannel(channelInput.parse(req.body))));
});

app.patch("/api/channels/:id", (req, res) => {
  getChannel(req.params.id);
  res.json(publicChannel(db.updateChannel(req.params.id, channelInput.partial().parse(req.body))!));
});

app.delete("/api/channels/:id", (req, res) => {
  getChannel(req.params.id);
  db.deleteChannel(req.params.id);
  res.json({ ok: true });
});

app.post("/api/channels/:id/ideas", async (req, res) => {
  requireAi();
  const channel = getChannel(req.params.id);
  const { count, focus } = z
    .object({ count: z.number().int().min(1).max(20).default(10), focus: z.string().max(300).optional() })
    .parse(req.body ?? {});
  const existing = db.videos(channel.id).map((v) => v.title);
  const ideas = await generateIdeas(channel, count, existing, focus);
  const created = ideas.map((idea) => db.createVideo({ channelId: channel.id, ...idea }));
  res.json(created.map(publicVideo));
});

app.post("/api/channels/:id/sync", async (req, res) => {
  const channel = getChannel(req.params.id);
  await syncChannel(channel);
  res.json(publicChannel(db.channel(channel.id)!));
});

// ---------- YouTube connection ----------

app.get("/api/channels/:id/youtube/connect", (req, res) => {
  if (!youtubeConfigured()) throw new HttpError(400, "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first.");
  const channel = getChannel(req.params.id);
  const nonce = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth", `${nonce}:${channel.id}`, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
  res.redirect(authUrl(nonce));
});

app.get("/api/youtube/callback", async (req, res) => {
  const [nonce, channelId] = String(req.signedCookies.oauth ?? "").split(":");
  res.clearCookie("oauth");
  const back = (params: string) => res.redirect(`/#/channels/${channelId ?? ""}?${params}`);

  if (req.query.error) return back(`youtube=error&message=${encodeURIComponent(String(req.query.error))}`);
  if (!nonce || req.query.state !== nonce || !db.channel(channelId)) {
    return back("youtube=error&message=" + encodeURIComponent("Login expired. Please try connecting again."));
  }
  try {
    await completeAuth(channelId, String(req.query.code));
    back("youtube=connected");
  } catch (err) {
    back(`youtube=error&message=${encodeURIComponent((err as Error).message)}`);
  }
});

app.post("/api/channels/:id/youtube/disconnect", (req, res) => {
  getChannel(req.params.id);
  res.json(publicChannel(db.updateChannel(req.params.id, { youtube: undefined, stats: undefined })!));
});

// ---------- Videos ----------

app.get("/api/videos", (req, res) => {
  const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
  res.json(db.videos(channelId).map(publicVideo));
});

app.get("/api/videos/:id", (req, res) => {
  res.json(publicVideo(getVideo(req.params.id)));
});

app.post("/api/videos", (req, res) => {
  const input = z
    .object({
      channelId: z.string(),
      title: z.string().trim().min(1).max(200),
      format: z.enum(["short", "long"]).default("short"),
    })
    .parse(req.body);
  getChannel(input.channelId);
  res.json(publicVideo(db.createVideo(input)));
});

const videoPatch = z
  .object({
    status: z.enum(["idea", "scripted", "ready", "scheduled", "published", "failed"]),
    format: z.enum(["short", "long"]),
    title: z.string().max(200),
    hook: z.string().max(1000),
    keyword: z.string().max(200),
    angle: z.string().max(1000),
    script: z.string().max(100_000),
    description: z.string().max(5000),
    tags: z.array(z.string().max(100)).max(50),
    scheduledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .partial();

app.patch("/api/videos/:id", (req, res) => {
  const video = getVideo(req.params.id);
  const patch = videoPatch.parse(req.body);
  if (video.youtubeVideoId && (patch.title !== undefined || patch.scheduledAt !== undefined)) {
    throw new HttpError(400, "This video is already on YouTube. Edit it in YouTube Studio.");
  }
  const { scheduledAt, ...rest } = patch;
  res.json(publicVideo(db.updateVideo(video.id, { ...rest, ...(scheduledAt !== undefined && { scheduledAt: scheduledAt ?? undefined }) })!));
});

app.delete("/api/videos/:id", (req, res) => {
  getVideo(req.params.id);
  db.deleteVideo(req.params.id);
  res.json({ ok: true });
});

app.post("/api/videos/:id/script", async (req, res) => {
  requireAi();
  const video = getVideo(req.params.id);
  const script = await generateScript(getChannel(video.channelId), video);
  res.json(publicVideo(db.updateVideo(video.id, { script, status: video.status === "idea" ? "scripted" : video.status })!));
});

app.post("/api/videos/:id/metadata", async (req, res) => {
  requireAi();
  const video = getVideo(req.params.id);
  const meta = await generateMetadata(getChannel(video.channelId), video);
  res.json(
    publicVideo(
      db.updateVideo(video.id, {
        titleOptions: meta.titles,
        description: meta.description,
        tags: meta.tags,
      })!,
    ),
  );
});

// ---------- Files ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 ** 3 },
});

app.post("/api/videos/:id/files/:kind", upload.single("file"), (req, res) => {
  const video = getVideo(String(req.params.id));
  const kind = String(req.params.kind);
  const file = req.file;
  const reject = (message: string) => {
    if (file) fs.rm(file.path, { force: true }, () => {});
    throw new HttpError(400, message);
  };
  if (!file) return reject("No file received.");
  if (video.youtubeVideoId) return reject("This video is already on YouTube.");

  const stored = { path: file.path, name: file.originalname, size: file.size, mimeType: file.mimetype };
  let patch: Partial<Video>;
  if (kind === "video") {
    if (!file.mimetype.startsWith("video/")) return reject("Please choose a video file (MP4 or MOV).");
    patch = { videoFile: stored, status: ["idea", "scripted"].includes(video.status) ? "ready" : video.status };
    if (video.videoFile) fs.rm(video.videoFile.path, { force: true }, () => {});
  } else if (kind === "thumbnail") {
    if (!["image/jpeg", "image/png"].includes(file.mimetype)) return reject("Thumbnails must be JPG or PNG.");
    if (file.size > 2 * 1024 ** 2) return reject("YouTube thumbnails must be under 2 MB.");
    patch = { thumbnailFile: stored };
    if (video.thumbnailFile) fs.rm(video.thumbnailFile.path, { force: true }, () => {});
  } else {
    return reject("Unknown file type.");
  }
  res.json(publicVideo(db.updateVideo(video.id, patch)!));
});

app.get("/api/videos/:id/thumbnail", (req, res) => {
  const video = getVideo(req.params.id);
  if (!video.thumbnailFile) throw new HttpError(404, "No thumbnail.");
  res.sendFile(video.thumbnailFile.path);
});

// ---------- Publishing ----------

const uploading = new Set<string>();

app.post("/api/videos/:id/publish", (req, res) => {
  const video = getVideo(req.params.id);
  if (video.youtubeVideoId) throw new HttpError(400, "This video is already on YouTube.");
  if (uploading.has(video.id)) throw new HttpError(409, "This video is already uploading.");
  if (!video.videoFile) throw new HttpError(400, "Upload the video file first.");
  if (!db.channel(video.channelId)?.youtube) throw new HttpError(400, "Connect this channel to YouTube first.");

  // Large uploads take minutes, so run in the background; the browser polls the video.
  uploading.add(video.id);
  db.updateVideo(video.id, { error: undefined });
  uploadAndSchedule(video)
    .catch((err: Error) => db.updateVideo(video.id, { status: "failed", error: err.message }))
    .finally(() => uploading.delete(video.id));
  res.json({ ...publicVideo(db.video(video.id)!), uploading: true });
});

app.get("/api/uploads", (_req, res) => {
  res.json([...uploading]);
});

// ---------- Errors ----------

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err instanceof Anthropic.AuthenticationError) {
    return res.status(502).json({ error: "Your Anthropic API key is invalid. Check ANTHROPIC_API_KEY." });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(503).json({ error: "The AI is busy right now. Wait a minute and try again." });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(502).json({ error: `AI error: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: (err as Error).message || "Something went wrong." });
});

// ---------- Frontend ----------

if (PROD) {
  const dist = path.resolve("dist/client");
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(PORT, () => {
  console.log(`YouTube Studio running at http://localhost:${PORT}`);
  if (!PASSWORD) console.warn("APP_PASSWORD is not set: anyone who can reach this server can use it.");
});
