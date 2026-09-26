import { useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import { useApp } from "../App";
import { PageHeader } from "../components/ui";

export default function Setup() {
  const { status } = useApp();
  const [copied, setCopied] = useState(false);

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Setup" subtitle="Connect the services the app uses. Add keys to the .env file on your server, then restart the app." />

      <Section ok={status.ai} title="AI writing (Claude)">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Go to <Ext href="https://console.anthropic.com">console.anthropic.com</Ext>, sign up and add a payment method.</li>
          <li>Open <b>API Keys</b> and create a key.</li>
          <li>Put it in <code>.env</code> as <code>ANTHROPIC_API_KEY=...</code></li>
        </ol>
        <p className="mt-2 text-xs text-zinc-500">Used for ideas, scripts, titles, descriptions and tags. You pay per use; a script typically costs a few cents.</p>
      </Section>

      <Section ok={status.youtube} title="YouTube upload and stats (Google Cloud)">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Go to <Ext href="https://console.cloud.google.com/projectcreate">Google Cloud Console</Ext> and create a project (free).</li>
          <li>
            Open <Ext href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">YouTube Data API v3</Ext> and click <b>Enable</b>.
          </li>
          <li>
            Open <Ext href="https://console.cloud.google.com/auth/overview">Google Auth Platform</Ext>, set it up as <b>External</b>, and under{" "}
            <b>Audience</b> add your Google email as a <b>test user</b>.
          </li>
          <li>
            Under <b>Clients</b>, create an OAuth client of type <b>Web application</b> and add this <b>Authorized redirect URI</b>:
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1.5 dark:bg-zinc-800">{status.redirectUri}</code>
              <button
                className="btn-secondary"
                onClick={() => {
                  navigator.clipboard.writeText(status.redirectUri);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy
              </button>
            </div>
          </li>
          <li>Copy the client ID and secret into <code>.env</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.</li>
          <li>Restart the app, open a channel and click <b>Connect YouTube</b>.</li>
        </ol>
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <b>Important:</b> until Google verifies your project (an “audit” you request in Google Cloud), videos uploaded through the API
          are locked as private and test-mode logins expire after 7 days. For your own channels you can request the audit, or
          reconnect weekly and publish from YouTube Studio in the meantime.
        </div>
      </Section>

      <Section ok={status.passwordRequired} title="Password protection">
        <p>
          Set <code>APP_PASSWORD</code> and a random <code>SESSION_SECRET</code> in <code>.env</code> before putting this app on the internet.
          The app holds access to your YouTube channels.
        </p>
      </Section>

      <Section title="Tools that pair well with this app">
        <ul className="space-y-1.5">
          <li><b>CapCut</b> (free): edit, auto captions, music. Export 1080p and upload the file here.</li>
          <li><b>Canva</b> (free): thumbnails. Search “YouTube thumbnail” templates.</li>
          <li><b>vidIQ</b> (free extension): check keyword search volume before you pick an idea.</li>
          <li><b>OpusClip</b>: turn one long video into several Shorts, then add each as a Short here.</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ ok, title, children }: { ok?: boolean; title: string; children: ReactNode }) {
  return (
    <section className="card text-sm">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        {ok === undefined ? null : ok ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-600 text-white"><Check className="h-3 w-3" /></span>
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-300 text-white dark:bg-zinc-700"><X className="h-3 w-3" /></span>
        )}
        {title}
        {ok !== undefined && <span className={`text-xs font-normal ${ok ? "text-green-600" : "text-zinc-500"}`}>{ok ? "Connected" : "Not set up"}</span>}
      </h2>
      {children}
    </section>
  );
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-red-600 underline">
    {children}
  </a>
);
