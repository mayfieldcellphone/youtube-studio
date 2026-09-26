# YouTube Studio

Plan, write and schedule videos for several YouTube channels from one place.

**The flow for each video** (no camera or microphone needed):

1. **Ideas.** The AI suggests videos people search for, tailored to each channel.
2. **Research.** The AI searches the web and collects facts, marked confirmed, disputed or theory, with source links.
3. **Script.** The AI writes a hook-first script from the research, then a second "tough editor" pass rewrites it to cut clichés, sharpen the hook and add cliffhangers. You review and edit it.
4. **Make the video.** One click produces an expressive ElevenLabs voiceover, a new Pexels shot every few seconds with slow camera movement, a color grade per channel (cinematic, clean or warm), word-by-word captions (the spoken word is highlighted gold in Shorts) and optional background music that ducks under the voice, rendered with FFmpeg as a vertical Short or a horizontal video. You watch the preview. You can also upload a video made anywhere else.
5. **Title, description and tags.** The AI writes 5 title options, an SEO description, tags, disclaimers and your affiliate links.
6. **Schedule.** The app uploads the video to YouTube with a publish time, and YouTube publishes it even if this app is offline.
7. **Grow.** Channel and per-video views, likes and comments show on the dashboard.

Ready-made channel presets: **AI Tools Explained**, **Money Moves** (finance and side hustles) and **Untold History** (mysteries and history).

A kanban board per channel tracks each video from idea to scripted, ready, scheduled and published. A calendar shows every channel's schedule, and each channel's posting days are used to suggest the next free slot.

## Run it (easy way)

1. Install **Node.js 22 or newer** (the "LTS" download from [nodejs.org](https://nodejs.org)). This is a one-time step.
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
3. Double-click the start file:
   - **Windows:** `Start YouTube Studio (Windows).bat`
   - **Mac:** `Start YouTube Studio (Mac).command`. The first time, right-click it → **Open** → **Open**, because macOS blocks downloaded scripts until you allow them.
4. The first start takes a few minutes. Your browser then opens the app at http://localhost:3000.
5. Go to **Setup**, paste each key in its box and click **Save**. It works right away, with no restart and no files to edit.

Keep the black window open while you use the app. Close it to stop the app.

## Run it (developers)

```bash
npm install
npm run dev            # http://localhost:3000, reloads on code changes
# or
npm run build && npm start
```

Keys saved on the Setup page are stored in `data/settings.json` and take priority over `.env` (see `.env.example`). All data (channels, videos, uploaded files, settings) lives in `./data`. Set `DATA_DIR` to change it, and back that folder up.

The app only accepts connections from the same computer. To run it on a server, set `HOST=0.0.0.0`, set a password, and set `APP_URL` to its public https address.

## Keys

The in-app **Setup** page has the same steps, a box for each key, and a copy button for the redirect URI.

### Claude (AI writing)

Create a key at [console.anthropic.com](https://console.anthropic.com) and set `ANTHROPIC_API_KEY`. The app uses `claude-opus-5`, with automatic fallback if a request is declined.

### ElevenLabs (voiceover)

Create a key at [elevenlabs.io](https://elevenlabs.io) (profile → API Keys) and set `ELEVENLABS_API_KEY`. Choose each channel's narrator voice under **Edit channel**.

### Pexels (stock footage, free)

Get a key at [pexels.com/api](https://www.pexels.com/api/) and set `PEXELS_API_KEY`.

FFmpeg comes with `npm install` (`ffmpeg-static`), so there's nothing extra to install. Rendering takes a few minutes per video and uses a lot of CPU, so renders run one at a time.

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

On your own computer only you can open the app, so a password is optional (Setup → Login password). Always set one before putting the app on the internet, because the app holds upload access to your YouTube channels.

## Limits

- The video maker uses stock footage, so the result is a documentary-style video. For more polish, download the file, add music or effects in CapCut, and upload it again.
- Background music is one track per channel (Edit channel → Background music). Use royalty-free music only, such as YouTube Studio's Audio Library or Pixabay Music.
- Always watch the preview and read the research sources before scheduling. YouTube demonetizes low-effort, mass-produced videos, and the AI can make mistakes.

The caption font is Anton (SIL Open Font License, see `assets/fonts/OFL.txt`).
