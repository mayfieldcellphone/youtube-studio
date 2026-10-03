import { appUrl } from "./settings";

/**
 * Public privacy policy and terms pages. YouTube's API policies require apps that use the
 * YouTube API to publish both, link YouTube's Terms of Service and Google's Privacy Policy,
 * and explain how users revoke access.
 */

const contact = () =>
  process.env.APP_CONTACT_EMAIL ? `<a href="mailto:${escape(process.env.APP_CONTACT_EMAIL)}">${escape(process.env.APP_CONTACT_EMAIL)}</a>` : "the owner of this app";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Channel Planner</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 16px; color: #1f2328; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111; } a { color: #8ab4f8; } }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 1.8em; }
</style>
</head>
<body>
<h1>${title}</h1>
<p><i>Channel Planner, ${escape(appUrl())}. Last updated 3 October 2026.</i></p>
${body}
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></p>
</body>
</html>`;
}

export const privacyPage = () =>
  page(
    "Privacy policy",
    `<p>Channel Planner is a private tool its owner uses to plan, make and schedule videos for their own YouTube channels. It is not offered to the public.</p>

<h2>YouTube API Services</h2>
<p>Channel Planner uses YouTube API Services. By connecting a YouTube channel you agree to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, and Google's handling of your data is covered by the <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.</p>

<h2>What the app accesses and why</h2>
<ul>
<li><b>Upload videos</b> (youtube.upload): to upload and schedule videos you made and approved in the app, with the title, description, tags and thumbnail you set.</li>
<li><b>Read channel information</b> (youtube.readonly): the channel's name, picture, subscriber, view and video counts, and the view, like and comment counts and public/private status of videos uploaded from the app, shown on your dashboard.</li>
</ul>
<p>The app does not read your comments, messages, watch history or any other channel's data, and does not post, edit or delete anything except the uploads you start.</p>

<h2>How data is stored and shared</h2>
<p>Everything is stored only on the server that runs this app, owned by the app's owner: the Google access token for each connected channel and the statistics listed above. Nothing is sold, shared with or shown to anyone else, or used for advertising. Video scripts may be sent to AI services (Anthropic, Google) to write and narrate videos; no YouTube data is sent to them.</p>

<h2>Keeping and deleting data</h2>
<ul>
<li>Statistics are refreshed from YouTube every 30 minutes while the app runs, and are never kept longer than 30 days without being refreshed.</li>
<li><b>Disconnect</b> on a channel's page revokes the app's access at Google and deletes that channel's stored YouTube data from the app straight away.</li>
<li>You can also revoke access any time at <a href="https://security.google.com/settings/security/permissions">Google security settings</a>. The app then can no longer read or upload anything, and deletes the stored data the next time it tries.</li>
</ul>

<h2>Contact</h2>
<p>Questions or deletion requests: ${contact()}.</p>`,
  );

export const termsPage = () =>
  page(
    "Terms of use",
    `<p>Channel Planner is a private tool for its owner's own YouTube channels.</p>
<ul>
<li>Using the app's YouTube features means agreeing to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a> and following YouTube's <a href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/">Community Guidelines</a> and monetization policies.</li>
<li>You are responsible for every video uploaded through the app: review each one before it is scheduled, make sure you have the rights to all music and footage, and disclose realistic AI-generated content (the app sets YouTube's altered or synthetic content label automatically when it uses AI pictures or AI video).</li>
<li>AI-written research and scripts can contain mistakes. Check facts and sources before publishing.</li>
<li>See the <a href="/privacy">privacy policy</a> for how data is handled. Contact: ${contact()}.</li>
</ul>`,
  );
