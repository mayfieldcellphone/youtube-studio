import { useState } from "react";
import { Clapperboard } from "lucide-react";
import { api } from "../api";
import { ErrorBox, Spinner, useAction } from "../components/ui";

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

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
          <Clapperboard className="h-6 w-6 text-red-600" /> YouTube Studio
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
