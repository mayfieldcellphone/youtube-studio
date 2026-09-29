import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { 
  CalendarDays, 
  ChevronRight, 
  Clapperboard, 
  Film, 
  FolderKanban, 
  Image as ImageIcon, 
  LayoutDashboard, 
  LogOut, 
  Mic, 
  Plus, 
  Radio, 
  Settings, 
  Sparkles, 
  Tv, 
  Video as VideoIcon, 
  Wand2 
} from "lucide-react";
import { api, type Channel, type Status } from "./api";
import Dashboard from "./pages/Dashboard";
import ChannelForm from "./pages/ChannelForm";
import ChannelBoard from "./pages/ChannelBoard";
import VideoEditor from "./pages/VideoEditor";
import Calendar from "./pages/Calendar";
import Setup from "./pages/Setup";
import Login from "./pages/Login";
import CreativeTools from "./pages/CreativeTools";

interface AppState {
  status: Status;
  channels: Channel[];
  reloadChannels: () => Promise<void>;
  reloadStatus: () => Promise<void>;
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
    if (s.loggedIn) await reloadChannels();
    setStatus(s);
  }, [reloadChannels]);

  useEffect(() => {
    init();
  }, [init]);

  if (!status) return null;
  if (!status.loggedIn) return <Login locked={status.locked} onLogin={init} />;

  const [section, id, sub] = route.parts;
  let page: ReactNode;

  if (section === "channels" && id === "new") page = <ChannelForm key="new" />;
  else if (section === "channels" && id && sub === "edit") page = <ChannelForm key={id} channelId={id} />;
  else if (section === "channels" && id) page = <ChannelBoard key={id} channelId={id} params={route.params} />;
  else if (section === "videos" && id) page = <VideoEditor key={id} videoId={id} />;
  else if (section === "calendar") page = <Calendar />;
  else if (section === "setup") page = <Setup />;
  else if (section === "tools" && (id === "image" || id === "audio" || id === "video")) {
    page = <CreativeTools tool={id} />;
  } else if (section === "director") {
    // If director mode is clicked, route to first channel or dashboard
    if (channels.length > 0) {
      page = <ChannelBoard key={channels[0].id} channelId={channels[0].id} params={route.params} />;
    } else {
      page = <Dashboard />;
    }
  } else {
    page = <Dashboard />;
  }

  const activeChannel = section === "channels" ? id : undefined;

  return (
    <AppContext.Provider value={{ status, channels, reloadChannels, reloadStatus: init }}>
      <div className="flex min-h-screen flex-col md:flex-row">
        {/* OpenArt Inspired Sidebar */}
        <aside className="glass-panel z-20 flex flex-col border-b border-white/[0.08] md:sticky md:top-0 md:h-screen md:w-64 md:shrink-0 md:border-b-0 md:border-r">
          {/* Logo / Header */}
          <div className="flex items-center gap-3 px-5 py-5 border-b border-white/[0.06]">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff75cb] to-[#ff0099] shadow-[0_0_15px_rgba(255,0,153,0.35)]">
              <Clapperboard className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-bold tracking-tight text-white">
                  Studio Suite
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-pink-300">
                  AI 2.0
                </span>
              </div>
              <p className="truncate text-[11px] text-zinc-400">OpenArt Creator Studio</p>
            </div>
          </div>

          {/* Navigation Links grouped by categories */}
          <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
            {/* AGENTS SECTION */}
            <div>
              <div className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Agents
              </div>
              <div className="space-y-0.5">
                <NavLink href="/" icon={<Sparkles className="h-4 w-4 text-pink-400" />} active={!section || section === "chat"}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">Creator Hub</span>
                      <span className="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">AI</span>
                    </div>
                  </div>
                </NavLink>
                <NavLink 
                  href={channels.length > 0 ? `/channels/${channels[0].id}` : "/channels/new"} 
                  icon={<Film className="h-4 w-4 text-purple-400" />} 
                  active={section === "director"}
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">Director Mode</span>
                  </div>
                </NavLink>
              </div>
            </div>

            {/* CREATIVE TOOLS SECTION */}
            <div>
              <div className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Tools
              </div>
              <div className="space-y-0.5">
                <NavLink href="/tools/image" icon={<ImageIcon className="h-4 w-4 text-pink-400" />} active={section === "tools" && id === "image"}>
                  <span>Image Studio</span>
                </NavLink>
                <NavLink href="/tools/audio" icon={<Mic className="h-4 w-4 text-cyan-400" />} active={section === "tools" && id === "audio"}>
                  <span>Voice Studio</span>
                </NavLink>
                <NavLink href="/tools/video" icon={<VideoIcon className="h-4 w-4 text-blue-400" />} active={section === "tools" && id === "video"}>
                  <span>Video Engine</span>
                </NavLink>
              </div>
            </div>

            {/* CHANNELS SECTION */}
            <div>
              <div className="flex items-center justify-between px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                <span>Channels ({channels.length})</span>
                <a href="#/channels/new" className="text-zinc-400 hover:text-pink-400" title="Add Channel">
                  <Plus className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="space-y-0.5">
                {channels.map((c) => (
                  <NavLink key={c.id} href={`/channels/${c.id}`} active={activeChannel === c.id}>
                    <div className="flex w-full items-center justify-between gap-1.5 truncate">
                      <span className="truncate">{c.name}</span>
                      {c.youtube ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" title="Connected to YouTube" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400/60" title="Not connected" />
                      )}
                    </div>
                  </NavLink>
                ))}
                <NavLink href="/channels/new" icon={<Plus className="h-4 w-4 text-zinc-400" />} active={activeChannel === "new"}>
                  <span className="text-xs text-zinc-400">Add new channel...</span>
                </NavLink>
              </div>
            </div>

            {/* SCHEDULE & SETUP */}
            <div>
              <div className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Publishing
              </div>
              <div className="space-y-0.5">
                <NavLink href="/calendar" icon={<CalendarDays className="h-4 w-4 text-amber-400" />} active={section === "calendar"}>
                  <span>Calendar</span>
                </NavLink>
                <NavLink href="/setup" icon={<Settings className="h-4 w-4 text-zinc-400" />} active={section === "setup"}>
                  <span>Setup & API Keys</span>
                </NavLink>
              </div>
            </div>
          </nav>

          {/* Bottom user / logout bar */}
          {status.passwordRequired && (
            <div className="border-t border-white/[0.06] p-3">
              <button
                className="btn-ghost w-full justify-start text-xs text-zinc-400 hover:text-red-300"
                onClick={async () => {
                  await api.logout();
                  init();
                }}
              >
                <LogOut className="h-3.5 w-3.5" /> Log out
              </button>
            </div>
          )}
        </aside>

        {/* Main Content View */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {status.keyProblems?.length > 0 && (
            <div className="mb-6 rounded-2xl border border-red-500/30 bg-red-950/40 p-4 text-sm text-red-200 backdrop-blur-md shadow-[0_4px_20px_rgba(255,0,0,0.15)]">
              <p className="font-semibold text-red-100">Setup Action Needed:</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-red-300 space-y-0.5">
                {status.keyProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <a className="mt-2 inline-block text-xs font-semibold text-pink-300 underline hover:text-pink-200" href="#/setup">
                Open Setup page &rarr;
              </a>
            </div>
          )}
          {page}
        </main>
      </div>
    </AppContext.Provider>
  );
}

function NavLink({
  href,
  icon,
  active,
  children,
}: {
  href: string;
  icon?: ReactNode;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={`#${href}`}
      className={`group flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition duration-150 ${
        active
          ? "border border-pink-500/30 bg-pink-500/10 text-white shadow-[0_0_15px_rgba(255,0,153,0.15),inset_0_1px_0_rgba(255,255,255,0.1)]"
          : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
      }`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {active && <span className="h-1.5 w-1.5 rounded-full bg-pink-500 shadow-[0_0_6px_rgba(255,0,153,0.8)]" />}
    </a>
  );
}
