import { useState } from "react";
import { Clapperboard } from "lucide-react";
import { api } from "../api";
import { ErrorBox, Spinner, useAction } from "../components/ui";

export default function Login({ locked, onLogin }: { locked: boolean; onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

  if (locked) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card w-full max-w-md space-y-3 text-sm">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Clapperboard className="h-6 w-6 text-red-600" /> Channel Planner
          </div>
          <p className="font-medium">This app is online, so it needs a password before anyone can use it.</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              On the server, open the file <code>.env</code> in the app's folder (on the VPS: <code>/opt/channel-planner/.env</code>).
            </li>
            <li>
              Add a line <code>APP_PASSWORD=</code> followed by a password of at least 10 characters that only you know.
            </li>
            <li>
              Restart the app (on the VPS: <code>cd /opt/channel-planner &amp;&amp; docker compose up -d</code>), wait a minute and reload
              this page.
            </li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        className="card w-full max-w-sm space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          run("login", async () => {
            await api.login(password);
            onLogin();
          });
        }}
      >
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Clapperboard className="h-6 w-6 text-red-600" /> Channel Planner
        </div>
        <div className="space-y-1">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <ErrorBox error={error} />
        <button className="btn-primary w-full" disabled={!!busy}>
          {busy && <Spinner />} Log in
        </button>
      </form>
    </div>
  );
}
