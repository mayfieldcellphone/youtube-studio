# YouTube Studio

Plan, write and schedule videos for several YouTube channels from one place.

**The flow for each video:**

1. **Ideas.** The AI suggests videos people search for, tailored to each channel.
2. **Script.** The AI writes a hook-first script with filming directions.
3. **Record and upload.** You film on your phone and edit in CapCut, then upload the final file here.
4. **Title, description and tags.** The AI writes 5 title options, an SEO description and tags.
5. **Schedule.** The app uploads the video to YouTube with a publish time, and YouTube publishes it even if this app is offline.
6. **Grow.** Channel and per-video views, likes and comments show on the dashboard.

A kanban board per channel tracks each video from idea to scripted, ready, scheduled and published. A calendar shows every channel's schedule, and each channel's posting days are used to suggest the next free slot.

## Run it

Requires Node.js 22+.

```bash
npm install
cp .env.example .env   # then fill in the keys (see below)
npm run dev            # http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

Data (channels, videos, uploaded files) is stored in `./data`. Set `DATA_DIR` to change it, and back that folder up.

## Keys

The in-app **Setup** page has the same steps, plus a copy button for the redirect URI.

### Claude (AI writing)

Create a key at [console.anthropic.com](https://console.anthropic.com) and set `ANTHROPIC_API_KEY`. The app uses `claude-opus-5`, with automatic fallback if a request is declined.

### YouTube (upload + stats)

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/projectcreate).
2. Enable **YouTube Data API v3**.
3. In **Google Auth Platform**, choose **External** and add your Google account as a **test user**.
4. Create an **OAuth client** of type **Web application**. Add the redirect URI `APP_URL/api/youtube/callback`, for example `http://localhost:3000/api/youtube/callback`.
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `APP_URL`.
6. Open a channel in the app and click **Connect YouTube**. If your Google account has several channels, Google asks which one. Repeat this for each channel.

**Google limits for unverified projects:**

- Videos uploaded through the API are locked **private** until your project passes Google's API audit. Request the audit from the YouTube API Services form linked in Google Cloud.
- In "Testing" mode, logins expire after 7 days. Reconnect the channel when that happens, or publish the app in Google Auth Platform.

### Security

Set `APP_PASSWORD` and a random `SESSION_SECRET` before putting the app on the internet. The app holds upload access to your YouTube channels.

## What's not automated (yet)

- **Filming and editing.** CapCut and Canva have no public API for this. Editing happens in CapCut and the final file is uploaded here.
- **Auto-editing** (captions, silence trimming, Shorts crop) and **thumbnail generation** are the planned next step. Both run server-side with FFmpeg.
