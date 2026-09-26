import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { CalendarDays, LayoutDashboard, LogOut, Plus, Settings, Clapperboard } from "lucide-react";
import { api, type Channel, type Status } from "./api";
import Dashboard from "./pages/Dashboard";
import ChannelForm from "./pages/ChannelForm";
import ChannelBoard from "./pages/ChannelBoard";
import VideoEditor from "./pages/VideoEditor";
import Calendar from "./pages/Calendar";
import Setup from "./pages/Setup";
import Login from "./pages/Login";

interface AppState {
  status: Status;
  channels: Channel[];
  reloadChannels: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);
export const useApp = () => useContext(AppContext)!;

/** Current hash route split into path segments and query params, e.g. "#/channels/abc?x=1". */
function useRoute() {
  const read = () => {
    const [path, query = ""] = window.location.hash.replace(/^#/, "").split("?");
    return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const navigate = (path: string) => {
  window.location.hash = path;
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const route = useRoute();

  const reloadChannels = useCallback(async () => setChannels(await api.channels()), []);

  const init = useCallback(async () => {
    const s = await api.status();
    setStatus(s);
    if (s.loggedIn) await reloadChannels();
  }, [reloadChannels]);

  useEffect(() => {
    init();
  }, [init]);

  if (!status) return null;
  if (!status.loggedIn) return <Login onLogin={init} />;

  const [section, id, sub] = route.parts;
  let page: ReactNode;
  if (section === "channels" && id === "new") page = <ChannelForm key="new" />;
  else if (section === "channels" && id && sub === "edit") page = <ChannelForm key={id} channelId={id} />;
  else if (section === "channels" && id) page = <ChannelBoard key={id} channelId={id} params={route.params} />;
  else if (section === "videos" && id) page = <VideoEditor key={id} videoId={id} />;
  else if (section === "calendar") page = <Calendar />;
  else if (section === "setup") page = <Setup />;
  else page = <Dashboard />;

  const activeChannel = section === "channels" ? id : undefined;

  return (
    <AppContext.Provider value={{ status, channels, reloadChannels }}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside className="border-b border-zinc-200 bg-white md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-2 px-4 py-4 font-semibold">
            <Clapperboard className="h-6 w-6 text-red-600" />
            YouTube Studio
          </div>
          <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:pb-0">
            <NavLink href="/" icon={<LayoutDashboard className="h-4 w-4" />} active={!section}>
              Dashboard
            </NavLink>
            <NavLink href="/calendar" icon={<CalendarDays className="h-4 w-4" />} active={section === "calendar"}>
              Calendar
            </NavLink>
            <NavLink href="/setup" icon={<Settings className="h-4 w-4" />} active={section === "setup"}>
              Setup
            </NavLink>
            <div className="hidden px-3 pb-1 pt-5 text-xs font-semibold uppercase tracking-wide text-zinc-400 md:block">
              Channels
            </div>
            {channels.map((c) => (
              <NavLink key={c.id} href={`/channels/${c.id}`} active={activeChannel === c.id}>
                <span className="truncate">{c.name}</span>
              </NavLink>
            ))}
            <NavLink href="/channels/new" icon={<Plus className="h-4 w-4" />} active={activeChannel === "new"}>
              New channel
            </NavLink>
          </nav>
          {status.passwordRequired && (
            <button
              className="btn-ghost m-2 hidden md:absolute md:bottom-2 md:inline-flex"
              onClick={async () => {
                await api.logout();
                init();
              }}
            >
              <LogOut className="h-4 w-4" /> Log out
            </button>
          )}
        </aside>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">{page}</main>
      </div>
    </AppContext.Provider>
  );
}

function NavLink({ href, icon, active, children }: { href: string; icon?: ReactNode; active: boolean; children: ReactNode }) {
  return (
    <a
      href={`#${href}`}
      className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm ${
        active
          ? "bg-red-50 font-medium text-red-700 dark:bg-red-950/50 dark:text-red-400"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      }`}
    >
      {icon}
      {children}
    </a>
  );
}
