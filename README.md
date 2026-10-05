# Channel Planner

Plan, write and schedule videos for several YouTube channels from one place.

**The flow for each video** (no camera or microphone needed):

1. **Ideas.** The AI first searches the web for what's getting attention in the channel's niche right now (news, anniversaries, topics that are overdone), then suggests videos tailored to each channel.
2. **Research.** The AI searches the web and collects facts, marked confirmed, disputed or theory, with source links.
3. **Script.** The AI writes a hook-first script from the research, then a second "tough editor" pass rewrites it to cut clichés, sharpen the hook and add cliffhangers. You review and edit it.
4. **Make the video.** One click produces a voiceover (Kokoro free/local, Gemini, or ElevenLabs, chosen per channel), a new shot every few seconds with slow camera movement (Pexels stock footage, or an AI picture drawn for each line of the story), a color grade per channel (cinematic, clean or warm), word-by-word captions (the spoken word is highlighted gold in Shorts) and optional background music that ducks under the voice, rendered with FFmpeg as a vertical Short or a horizontal video. You watch the preview. You can also upload a video made anywhere else.
5. **Title, description and tags.** The AI writes 5 title options, an SEO description, tags, disclaimers and your affiliate links.
6. **Schedule.** The app uploads the video to YouTube with a publish time, and YouTube publishes it even if this app is offline.
7. **Grow.** Channel and per-video views, likes and comments show on the dashboard.

Ready-made channel presets: **AI Tools Explained**, **Money Moves** (finance and side hustles) and **Untold History** (mysteries and history).

**Make several videos automatically:** on a channel's board, tick 2-3 ideas (or click "Select next 3 ideas"), choose how far the app should go on its own (script only; full video for you to review; or all the way to scheduling in your next posting slots), and it works through them one by one in the background, showing progress on each card. Any video can still be done step by step by hand.

A kanban board per channel tracks each video from idea to scripted, ready, scheduled and published. A calendar shows every channel's schedule, and each channel's posting days are used to suggest the next free slot.

## Run it (easy way)

1. Install **Node.js 22 or newer** (the "LTS" download from [nodejs.org](https://nodejs.org)). This is a one-time step.
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
3. Double-click the start file:
   - **Windows:** `Start Channel Planner (Windows).bat`
   - **Mac:** `Start Channel Planner (Mac).command`. The first time, right-click it → **Open** → **Open**, because macOS blocks downloaded scripts until you allow them.
4. The first start takes a few minutes. Your browser then opens the app at http://localhost:3000.
5. Go to **Setup**, paste each key in its box and click **Save**. It works right away, with no restart and no files to edit.

Keep the black window open while you use the app. Close it to stop the app.

## Run it online (Railway), updated on every GitHub push

Open the app from any computer or phone, with nothing to download. [Railway](https://railway.com) builds this repo with its `Dockerfile` and redeploys it automatically each time `main` changes. It costs about $5-15 a month, depending on how many videos you render.

1. Sign in at [railway.com](https://railway.com) with GitHub, and pick the **Hobby** plan.
2. Click **New Project** → **Deploy from GitHub repo** → `youtube-studio`. If the repo isn't listed, click **Configure GitHub App** and allow it.
3. In the new service, open the **Variables** tab → **New Variable**: name `APP_PASSWORD`, value a password of at least 10 characters. Until this is set, the app stays locked.
4. Right-click the service → **Attach volume**, with mount path `/data`. Channels, videos, keys and uploads live there and survive updates.
5. **Settings** → **Networking** → **Generate Domain**. Your app gets an address like `https://youtube-studio-production.up.railway.app`.
6. Click **Deploy**. When it's done, open the address, log in, and enter your keys on the **Setup** page.
7. Copy the new redirect URI from Setup box 4, add it to your Google OAuth client's **Authorized redirect URIs**, then click **Connect YouTube** again on each channel.

The app detects its Railway address by itself, so leave **App address** empty. An update restarts the app, and a video that was rendering at that moment has to be started again.

## Run it (developers)

```bash
npm install
npm run dev            # http://localhost:3000, reloads on code changes
# or
npm run build && npm start
```

Keys saved on the Setup page are stored in `data/settings.json` and take priority over `.env` (see `.env.example`). All data (channels, videos, uploaded files, settings) lives in `./data`. Set `DATA_DIR` to change it, and back that folder up.

The app only accepts connections from the same computer. To run it on a server, set `HOST=0.0.0.0` (the `Dockerfile` does this), set `APP_PASSWORD` (at least 10 characters; the app stays locked without one) and set `APP_URL` to its public https address (automatic on Railway). After 5 wrong passwords, an address has to wait 15 minutes.

## Keys

The in-app **Setup** page has the same steps, a box for each key, and a copy button for the redirect URI.

### Claude (AI writing)

Create a key at [console.anthropic.com](https://console.anthropic.com) and set `ANTHROPIC_API_KEY`. The app uses `claude-opus-5`, with automatic fallback if a request is declined.

### Voiceover: pick an engine per channel (Edit channel → Voice engine)

- **Kokoro**: free and unlimited, runs on your computer (open-source model, English). No key needed. The first use downloads the model (about 90 MB) into `data/models`.
- **Gemini**: very natural, and follows a narration style you describe. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and set `GEMINI_API_KEY`. The free tier allows only a few voice requests per day; turn on billing for regular use.
- **ElevenLabs**: the most human voice, paid by monthly characters. Create a key at [elevenlabs.io](https://elevenlabs.io) (profile → API Keys, allow Text to Speech, Voices read and write, User read, and Text to Voice if listed, which character voices need) and set `ELEVENLABS_API_KEY`.

ElevenLabs returns exact word timings for captions. For Kokoro and Gemini the app estimates them from the text, which stays close because scenes are 1-2 sentences.

### Character voices (optional, step 3 "Characters" on a video's page)

Dramatised scenes where people from the story speak in their own voices, while the narrator (any engine) tells the rest. Needs the ElevenLabs key.

1. Research the story, then open its page. The app suggests the speaking characters (name, who they are, a voice description and a sample line) and designs three ElevenLabs voices for each with Voice Design. It also offers this when you first click **Write script with AI**.
2. Listen, pick a voice for each character (or one already in your ElevenLabs account), edit anything, and click **Save characters**. Only then are the chosen voices created in your ElevenLabs account.
3. Write the script. The AI gives the characters short lines, each starting with the name in capitals and an optional delivery cue:

   ```
   In March 1431, the court read out Article 7.
   PROSECUTOR: [cold] You carried a mandrake, hoping it would bring you riches.
   JOAN: [firm] I deny it entirely.
   ```

   Lines without a label (or labelled `NARRATOR:`) are read by the narrator.

4. **On screen:** each saved character gets a painted portrait (Gemini, from the "how they look" description). While a character speaks, the video shows their portrait lip-synced to their line by [Hedra](https://www.hedra.com) (set `HEDRA_API_KEY` on the Setup page, about $0.05 per second of character speech). Without a Hedra key the portrait is shown still, with a slow push-in. Use **New portrait** or **Change look** on the video page to redo one; the 9:16 version for Shorts is painted from the 16:9 one so the face matches. `HEDRA_MODEL` can force a specific Hedra model. Characters who appear in many videos, such as a host, can be added once under **Edit channel → Recurring character voices**.

Character lines use ElevenLabs Eleven v3, which acts the cue (`[whispering]`, `[afraid]`); if the account can't use v3 the line is read without the cue. A label with no voice in the cast is read by the narrator, with a note. While a character speaks the video shows a small **DRAMATISATION** label, and on upload the video is marked as altered/synthetic content and the description ends with "Contains dramatised scenes with AI voices."

### AI pictures (optional, Edit channel → Visuals)

Instead of stock footage, the app can draw a picture for every shot with Gemini's image model, using the same Gemini key (billing required). Each picture shows what the narrator is saying at that moment, in the right era and place, and the video maker moves slowly across it. Roughly $0.04 per picture: about $0.70 for a Short and $4 for a 10-minute video. Pictures Gemini refuses use stock footage instead, with a note. Videos with AI pictures are marked as altered/synthetic content when uploaded.

### AI footage with Google Veo (optional, Edit channel → AI footage)

Veo is the video model behind Google Flow. The app uses it through the same Gemini key (billing required) to make custom 8-second shots for the opening hook, the key moments, or every scene; Pexels stock footage fills the rest. The app asks Google which Veo models the key can use and picks the newest (Fast or Best quality). Shots Veo refuses or fails fall back to stock footage with a note. Videos containing Veo footage are marked as altered/synthetic content when uploaded, as YouTube requires. The cost estimate on the video page uses rough list prices; Google's pricing page is authoritative.

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

### YouTube's rules

The app follows YouTube's API policies: it publishes a privacy policy at `/privacy` and terms at `/terms` (public, no login), links the YouTube Terms of Service and Google Privacy Policy where you connect a channel, refreshes stored YouTube statistics every 30 minutes, and **Disconnect** revokes the app's Google access and deletes that channel's stored YouTube data. Set `APP_CONTACT_EMAIL` to show a contact address on those pages. Use `https://<your app address>/privacy` as the privacy policy link on Google's OAuth consent screen and in the YouTube API audit form.

The AI follows YouTube's content policies when writing (original angles, no invented facts, no misleading titles, advertiser-friendly). You still review every video before it's scheduled.

### Security

On your own computer only you can open the app, so a password is optional (Setup → Login password). Always set one before putting the app on the internet, because the app holds upload access to your YouTube channels.

## Limits

- The video maker uses stock footage, so the result is a documentary-style video. For more polish, download the file, add music or effects in CapCut, and upload it again.
- Background music is one track per channel (Edit channel → Background music). Use royalty-free music only, such as YouTube Studio's Audio Library or Pixabay Music.
- Always watch the preview and read the research sources before scheduling. YouTube demonetizes low-effort, mass-produced videos, and the AI can make mistakes.

The caption font is Anton (SIL Open Font License, see `assets/fonts/OFL.txt`).
