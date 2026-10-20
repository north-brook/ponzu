import type { Catalog } from "@ponzu/core";
import {
  AgentMark,
  Canvas,
  Icon,
  Logo,
  SocketSource,
  Tip,
  TipProvider,
  useSource,
} from "@ponzu/react";
import { useEffect, useMemo, useState } from "react";
import { Dashboard, type OpenTarget } from "@/components/dashboard";
import { Button } from "@/components/ui/button";
import { WhatsNew } from "@/components/whats-new";
import { cn } from "@/lib/utils";

/** Where `ponzu serve` lives. Same origin in production; the dev server proxies. */
const ORIGIN = window.location.origin;
const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/**
 * A tab names its design and the server in front of it: the key alone for a
 * design on this Mac, `<base>\n<key>` for one on another Mac, which this Mac's
 * server relays at `<base>` (`/peers/<name>`).
 */
const tabOf = ({ key, base }: OpenTarget) => (base ? `${base}\n${key}` : key);
const targetOf = (tab: string): OpenTarget => {
  const i = tab.indexOf("\n");
  return i < 0 ? { key: tab, base: "" } : { base: tab.slice(0, i), key: tab.slice(i + 1) };
};

declare global {
  interface Window {
    /** Set by the desktop app's preload script. */
    ponzuDesktop?: {
      platform: string;
      openFolder(): Promise<string | null>;
      newFile(): Promise<string | null>;
      reveal(path: string): void;
      /** Missing from builds before What's new. */
      whatsNew?(): Promise<{ version: string; notes: string[] } | null>;
      whatsNewSeen?(): void;
    };
  }
}

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

/** Follows the system appearance. */
function useTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(darkScheme.matches ? "dark" : "light");
  useEffect(() => {
    const onChange = () => setTheme(darkScheme.matches ? "dark" : "light");
    darkScheme.addEventListener("change", onChange);
    return () => darkScheme.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return theme;
}

export function Studio() {
  const theme = useTheme();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [tabs, setTabs] = useState<string[]>(() => {
    const q = new URLSearchParams(location.search).get("file");
    const saved = JSON.parse(localStorage.getItem("ponzu.tabs") ?? "[]") as string[];
    return q ? [...new Set([...saved, q])] : saved;
  });
  const [active, setActive] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("file"),
  );
  const sources = useMemo(() => new Map<string, SocketSource>(), []);
  const source = (tab: string) => {
    let s = sources.get(tab);
    if (!s) {
      const { key, base } = targetOf(tab);
      s = new SocketSource(`${ORIGIN}${base}`, key);
      sources.set(tab, s);
    }
    return s;
  };

  // The home screen's catalog: polled while it shows, fetched once otherwise so the
  // file an agent just made is known when it opens.
  useEffect(() => {
    let stop = false;
    const refresh = () =>
      fetch(`${ORIGIN}/api/catalog`)
        .then((r) => r.json())
        .then((c: Catalog) => !stop && setCatalog(c))
        .catch(() => {});
    void refresh();
    if (active)
      return () => {
        stop = true;
      };
    const t = setInterval(refresh, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [active]);

  // A design an agent creates opens in a tab as soon as it exists, once.
  const [seen] = useState(() => new Set<string>());
  useEffect(() => {
    if (!catalog) return;
    for (const f of catalog.files) {
      if (f.machine !== "local" || !f.created || seen.has(f.key)) continue;
      seen.add(f.key);
      if (Date.now() - f.created > 60_000 || tabs.includes(f.key)) continue;
      setTabs((t) => (t.includes(f.key) ? t : [...t, f.key]));
      setActive(f.key);
    }
  }, [catalog]);

  useEffect(() => {
    localStorage.setItem("ponzu.tabs", JSON.stringify(tabs));
    const url = new URL(location.href);
    if (active) url.searchParams.set("file", active);
    else url.searchParams.delete("file");
    history.replaceState(null, "", url);
  }, [tabs, active]);

  const openFile = async (target: OpenTarget) => {
    // A design here opens through the API, which lets the server read a guarded folder now
    // that the person asked for it. One on another Mac opens with its socket.
    if (!target.base)
      await fetch(`${ORIGIN}/api/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target.key }),
      });
    const tab = tabOf(target);
    setTabs((t) => (t.includes(tab) ? t : [...t, tab]));
    setActive(tab);
  };

  const closeTab = (key: string) => {
    sources.get(key)?.close();
    sources.delete(key);
    setTabs((t) => t.filter((k) => k !== key));
    if (active === key) setActive(null);
  };

  // ⌘0 goes home, ⌘1–8 open file tabs, ⌘9 the last, and ⌘⇧[ ⌘⇧] cycle through home and
  // the tabs, like a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const step = e.shiftKey && { BracketLeft: -1, BracketRight: 1 }[e.code];
      if (step) {
        e.preventDefault();
        const stops = [null, ...tabs];
        const i = stops.indexOf(active);
        setActive(stops[(i + step + stops.length) % stops.length] ?? null);
        return;
      }
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
      if (!digit || e.shiftKey) return;
      if (digit === "0") {
        e.preventDefault();
        setActive(null);
        return;
      }
      const key = digit === "9" ? tabs.at(-1) : tabs[Number(digit) - 1];
      if (!key) return;
      e.preventDefault();
      setActive(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, active]);

  const desktop = window.ponzuDesktop;
  const isMac = desktop?.platform === "darwin";

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 px-2",
          desktop && "app-drag [&_button]:app-no-drag",
          // Electron on macOS: room for the traffic lights. Since macOS 26 they end at x=76;
          // this keeps the logo 19px clear of them.
          isMac && "pl-[88px]",
        )}
      >
        <TipProvider>
          <Tip label="Home" keys={[mod.trim(), "0"]} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Home"
              className={cn("w-8", active === null && "bg-secondary hover:bg-secondary")}
              onClick={() => setActive(null)}
            >
              <Logo size={18} dark={theme === "dark"} />
            </Button>
          </Tip>
          <div className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none]">
            {tabs.map((key, i) => (
              <FileTab
                key={key}
                source={source(key)}
                shortcut={i < 8 ? i + 1 : i === tabs.length - 1 ? 9 : undefined}
                remote={targetOf(key).base.replace(/^\/peers\//, "")}
                active={key === active}
                onClick={() => setActive(key)}
                onClose={() => closeTab(key)}
              />
            ))}
          </div>
        </TipProvider>
        <div className="ml-auto flex items-center gap-1.5">
          {active && <AgentDots source={source(active)} />}
        </div>
      </header>
      <main className="min-h-0 flex-1 px-2 pb-2">
        {active ? (
          <div className="h-full overflow-hidden rounded-xl bg-canvas" key={active}>
            <Canvas source={source(active)} theme={theme} me={{ kind: "user", name: "You" }} />
          </div>
        ) : (
          <Dashboard
            catalog={catalog}
            onOpen={(t) => void openFile(t)}
            onOpenFolder={
              desktop &&
              (async () => {
                const picked = await desktop.openFolder();
                if (picked) await openFile({ key: picked, base: "" });
              })
            }
            onNew={
              desktop &&
              (async () => {
                const created = await desktop.newFile();
                if (created) await openFile({ key: created, base: "" });
              })
            }
          />
        )}
      </main>
      <WhatsNew />
    </div>
  );
}

function FileTab({
  source,
  shortcut,
  remote,
  active,
  onClick,
  onClose,
}: {
  source: SocketSource;
  shortcut?: number;
  /** The Mac the design is on, when it isn't this one. */
  remote?: string;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const state = useSource(source);
  const busy = state.presence.some((p) => p.working.length > 0);
  const name =
    state.doc?.name ??
    source.file
      .split("/")
      .pop()
      ?.replace(/\.design$/, "");
  const label = remote ? `${name} on ${decodeURIComponent(remote)}` : (name ?? "");
  return (
    <Tip label={label} keys={shortcut ? [mod.trim(), String(shortcut)] : undefined} side="bottom">
      <div
        className={cn(
          "group app-no-drag flex h-7 max-w-[220px] shrink-0 cursor-default items-center gap-[7px] whitespace-nowrap rounded-lg pr-1.5 pl-2.5 outline-none",
          active
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={onClick}
        onKeyDown={(e) => e.key === "Enter" && onClick()}
        role="tab"
        tabIndex={0}
      >
        {busy ? (
          <span className="m-px size-3 animate-spin rounded-full border-[1.6px] border-current border-r-transparent [animation-duration:0.8s]" />
        ) : (
          <Icon name="blank" size={14} />
        )}
        <span className="truncate">{name}</span>
        {state.status === "offline" && (
          <span className="size-1.5 rounded-full bg-offline" title="Reconnecting" />
        )}
        <button
          type="button"
          aria-label="Close tab"
          className={cn(
            "grid size-[18px] place-items-center rounded-[5px] opacity-0 hover:bg-accent hover:opacity-100! group-hover:opacity-60",
            active && "opacity-60",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </Tip>
  );
}

function AgentDots({ source }: { source: SocketSource }) {
  const { presence } = useSource(source);
  const agents = presence.filter((p) => p.kind === "agent");
  if (!agents.length) return null;
  return (
    <div className="flex gap-1.5 pr-1">
      {agents.map((a) => (
        <span
          key={a.id}
          className="relative grid size-6 place-items-center"
          title={`${a.name}${a.working.length ? " · working" : a.status ? ` · ${a.status}` : " · connected"}`}
        >
          <AgentMark client={a.client} size={16} />
          <span
            className={cn(
              "absolute right-px bottom-px size-[7px] rounded-full shadow-[0_0_0_2px_var(--background)]",
              a.working.length ? "animate-pulse bg-busy" : "bg-online",
            )}
          />
        </span>
      ))}
    </div>
  );
}
