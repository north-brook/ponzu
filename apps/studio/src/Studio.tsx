import { AgentMark, Canvas, Icon, Logo, SocketSource, useSource } from "@ponzu/react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WhatsNew } from "@/components/whats-new";
import { cn } from "@/lib/utils";

/** Where `ponzu serve` lives. Same origin in production; the dev server proxies. */
const ORIGIN = window.location.origin;
const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

interface FileEntry {
  key: string;
  name: string;
  pages?: number;
  artboards?: number;
  open: boolean;
}

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
      /** ⌘W from the app menu. Returns the unsubscribe. Missing from builds before tab closing. */
      onCloseTab?(handler: () => void): () => void;
      closeWindow?(): void;
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
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [tabs, setTabs] = useState<string[]>(() => {
    const q = new URLSearchParams(location.search).get("file");
    const saved = JSON.parse(localStorage.getItem("ponzu.tabs") ?? "[]") as string[];
    return q ? [...new Set([...saved, q])] : saved;
  });
  const [active, setActive] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("file"),
  );
  const sources = useMemo(() => new Map<string, SocketSource>(), []);
  const source = (key: string) => {
    let s = sources.get(key);
    if (!s) {
      s = new SocketSource(ORIGIN, key);
      sources.set(key, s);
    }
    return s;
  };

  const refresh = () =>
    fetch(`${ORIGIN}/api/files`)
      .then((r) => r.json())
      .then((d: { files: FileEntry[] }) => setFiles(d.files))
      .catch(() => {});

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    localStorage.setItem("ponzu.tabs", JSON.stringify(tabs));
    const url = new URL(location.href);
    if (active) url.searchParams.set("file", active);
    else url.searchParams.delete("file");
    history.replaceState(null, "", url);
  }, [tabs, active]);

  const openFile = async (key: string) => {
    await fetch(`${ORIGIN}/api/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: key }),
    });
    setTabs((t) => (t.includes(key) ? t : [...t, key]));
    setActive(key);
    refresh();
  };

  // Closing the open tab opens its neighbour, like a browser, so ⌘W works through them.
  const closeTab = (key: string) => {
    sources.get(key)?.close();
    sources.delete(key);
    const i = tabs.indexOf(key);
    setTabs((t) => t.filter((k) => k !== key));
    if (active === key) setActive(tabs[i + 1] ?? tabs[i - 1] ?? null);
  };

  // ⌘W closes the open tab; at home it closes the window.
  useEffect(
    () =>
      window.ponzuDesktop?.onCloseTab?.(() => {
        if (active) closeTab(active);
        else window.ponzuDesktop?.closeWindow?.();
      }),
    [tabs, active],
  );

  // ⌘1 goes home, ⌘2–8 open file tabs, ⌘9 the last, and ⌘⇧[ ⌘⇧] cycle through home and
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
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!digit || e.shiftKey) return;
      if (digit === "1") {
        e.preventDefault();
        setActive(null);
        return;
      }
      const key = digit === "9" ? tabs.at(-1) : tabs[Number(digit) - 2];
      if (!key) return;
      e.preventDefault();
      setActive(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, active]);

  const { strip, dragProps } = useTabDrag(tabs, setTabs);

  const desktop = window.ponzuDesktop;
  const isMac = desktop?.platform === "darwin";

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 px-2",
          desktop && "app-drag [&_button]:app-no-drag",
          // Electron on macOS: room for the traffic lights.
          isMac && "pl-20",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className={cn("w-8", active === null && "bg-secondary hover:bg-secondary")}
          onClick={() => setActive(null)}
          title={`Home (${mod}1)`}
        >
          <Logo size={18} dark={theme === "dark"} />
        </Button>
        <div
          ref={strip}
          className="relative flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none]"
        >
          {tabs.map((key, i) => (
            <FileTab
              key={key}
              source={source(key)}
              shortcut={i < 7 ? i + 2 : i === tabs.length - 1 ? 9 : undefined}
              active={key === active}
              onClick={() => setActive(key)}
              onClose={() => closeTab(key)}
              {...dragProps(key)}
            />
          ))}
        </div>
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
          <Home files={files} onOpen={openFile} theme={theme} />
        )}
      </main>
      <WhatsNew />
    </div>
  );
}

type DragProps = ReturnType<ReturnType<typeof useTabDrag>["dragProps"]>;

function FileTab({
  source,
  shortcut,
  active,
  onClick,
  onClose,
  ...drag
}: {
  source: SocketSource;
  shortcut?: number;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
} & DragProps) {
  const state = useSource(source);
  const busy = state.presence.some((p) => p.working.length > 0);
  const name =
    state.doc?.name ??
    source.file
      .split("/")
      .pop()
      ?.replace(/\.design$/, "");
  return (
    <div
      className={cn(
        "group app-no-drag relative flex h-7 max-w-[220px] shrink-0 cursor-default select-none items-center whitespace-nowrap rounded-lg px-2.5 outline-none",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      role="tab"
      tabIndex={0}
      title={shortcut ? `${source.file} (${mod}${shortcut})` : source.file}
      {...drag}
    >
      {/* The close button sits over the end of the label, which fades out under it. */}
      <span className="flex min-w-0 items-center gap-[7px] group-focus-visible:[mask-image:linear-gradient(to_left,transparent_14px,#000_32px)] group-hover:[mask-image:linear-gradient(to_left,transparent_14px,#000_32px)]">
        {busy ? (
          <span className="m-px size-3 shrink-0 animate-spin rounded-full border-[1.6px] border-current border-r-transparent [animation-duration:0.8s]" />
        ) : (
          <Icon name="file" size={14} />
        )}
        <span className="truncate">{name}</span>
        {state.status === "offline" && (
          <span className="size-1.5 shrink-0 rounded-full bg-offline" title="Reconnecting" />
        )}
      </span>
      <button
        type="button"
        aria-label="Close tab"
        className="absolute top-1/2 right-1 grid size-[18px] -translate-y-1/2 place-items-center rounded-[5px] opacity-0 hover:bg-accent hover:opacity-100! group-focus-visible:opacity-60 group-hover:opacity-60"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

const slide = { duration: 150, easing: "ease-out" };

/**
 * Drag a tab along the strip to move it. It follows the pointer, and the others
 * slide out of its way as it passes their middles. Pointer events, not HTML drag
 * and drop: the strip sits in the desktop app's window-drag region.
 */
function useTabDrag(tabs: string[], setTabs: (tabs: string[]) => void) {
  const strip = useRef<HTMLDivElement>(null);
  const order = useRef(tabs);
  order.current = tabs;
  const drag = useRef<{
    el: HTMLElement;
    /** Where in the tab it was picked up. */
    grab: number;
    x: number;
    dx: number;
  } | null>(null);
  /** Where the other tabs were drawn before a move, to slide them from. */
  const before = useRef(new Map<HTMLElement, number>());

  // Hold the dragged tab under the pointer, wherever its slot in the strip is now.
  const follow = () => {
    const d = drag.current;
    const s = strip.current;
    if (!d || !s) return;
    const slot = s.getBoundingClientRect().left - s.scrollLeft + d.el.offsetLeft;
    d.dx = Math.min(
      Math.max(d.x - d.grab - slot, -d.el.offsetLeft),
      s.scrollWidth - d.el.offsetLeft - d.el.offsetWidth,
    );
    d.el.style.transform = `translateX(${d.dx}px)`;
  };

  useLayoutEffect(() => {
    for (const [el, left] of before.current) {
      for (const a of el.getAnimations()) a.cancel();
      const dx = left - el.getBoundingClientRect().left;
      if (dx) el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], slide);
    }
    before.current.clear();
    follow();
  }, [tabs]);

  const dragProps = (key: string) => ({
    onPointerDown: (down: ReactPointerEvent<HTMLElement>) => {
      // The close button clicks; it doesn't drag.
      if (down.button !== 0 || (down.target as Element).closest("button")) return;
      const el = down.currentTarget;
      const grab = down.clientX - el.getBoundingClientRect().left;
      // On the window, so a quick flick that leaves the tab still moves it.
      const move = (e: PointerEvent) => {
        const s = strip.current;
        if (!s) return;
        if (!drag.current) {
          if (Math.abs(e.clientX - down.clientX) < 4) return;
          drag.current = { el, grab, x: e.clientX, dx: 0 };
          el.style.zIndex = "1";
        }
        const d = drag.current;
        d.x = e.clientX;
        follow();
        const others = [...s.children].filter(
          (c): c is HTMLElement => c instanceof HTMLElement && c !== el,
        );
        // From the pointer, not the clamped tab: a wide tab held at the strip's end can't
        // reach the middle of a narrow one there.
        const left = s.getBoundingClientRect().left - s.scrollLeft;
        const middle = d.x - d.grab - left + el.offsetWidth / 2;
        const to = others.filter((c) => c.offsetLeft + c.offsetWidth / 2 < middle).length;
        const tabs = order.current;
        if (to === tabs.indexOf(key)) return;
        for (const c of others) before.current.set(c, c.getBoundingClientRect().left);
        const next = tabs.filter((k) => k !== key);
        next.splice(to, 0, key);
        setTabs(next);
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        el.style.transform = "";
        el.animate([{ transform: `translateX(${d.dx}px)` }, { transform: "none" }], slide)
          .finished.then(() => {
            el.style.zIndex = "";
          })
          .catch(() => {});
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
  });

  return { strip, dragProps };
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

const heading = "mb-3 font-semibold text-[15px]";
const muted = "my-2 text-muted-foreground";
const code = "font-mono text-xs";

function Home({
  files,
  onOpen,
  theme,
}: {
  files: FileEntry[];
  onOpen: (key: string) => void;
  theme: "light" | "dark";
}) {
  const [path, setPath] = useState("");
  const [copied, setCopied] = useState(false);
  const mcp = `${ORIGIN}/mcp`;
  const desktop = window.ponzuDesktop;
  return (
    <div className="h-full overflow-auto rounded-xl bg-canvas">
      <div className="mx-auto flex max-w-[720px] flex-col gap-10 px-8 py-[72px]">
        <div className="flex items-center gap-3.5">
          <Logo size={40} dark={theme === "dark"} />
          <h1 className="font-semibold text-[32px] tracking-[-0.03em]">Ponzu</h1>
        </div>

        <section>
          <h2 className={heading}>Files</h2>
          {files.length === 0 ? (
            <p className={muted}>
              No .design files yet. Ask your agent to create one, or run{" "}
              <code className={code}>ponzu init</code>.
            </p>
          ) : (
            <div className="flex flex-col overflow-hidden rounded-xl bg-card">
              {files.map((f) => (
                <button
                  type="button"
                  key={f.key}
                  className="flex items-center gap-3 border-b px-3.5 py-3 text-left last:border-b-0 hover:bg-accent"
                  onClick={() => onOpen(f.key)}
                >
                  <span className="grid size-9 place-items-center rounded-[9px] bg-canvas">
                    <Icon name="file" size={18} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="font-semibold">{f.name}</b>
                    <span className="truncate text-muted-foreground text-xs">
                      {f.key.replace(/^\/Users\/[^/]+/, "~")}
                    </span>
                  </span>
                  {f.artboards !== undefined && (
                    <span className="text-muted-foreground">{f.artboards} artboards</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) onOpen(path.trim());
            }}
          >
            {desktop ? (
              <>
                <Button
                  onClick={async () => {
                    const picked = await desktop.openFolder();
                    if (picked) onOpen(picked);
                  }}
                >
                  Open…
                </Button>
                <Button
                  onClick={async () => {
                    const created = await desktop.newFile();
                    if (created) onOpen(created);
                  }}
                >
                  New…
                </Button>
              </>
            ) : null}
            <Input
              className="flex-1"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/name.design"
            />
            <Button type="submit">Open</Button>
          </form>
        </section>

        <section>
          <h2 className={heading}>Connect an agent</h2>
          {desktop ? (
            <p className={muted}>
              Claude Code, Codex and Cursor on this Mac are already set up, and they reach Ponzu
              whether or not this window is open. Ask one to design something.
            </p>
          ) : (
            <p className={muted}>
              Ponzu speaks MCP. Run <code className={code}>ponzu install</code> to set up the agents
              on this machine, or point any agent at this server.
            </p>
          )}
          {/* The app already set agents up; registering a URL here would replace that. */}
          {!desktop && (
            <>
              <div className="flex items-center gap-3 rounded-[10px] bg-card py-2.5 pr-2.5 pl-3.5">
                <code className={cn(code, "flex-1 overflow-x-auto whitespace-nowrap")}>
                  claude mcp add --transport http ponzu {mcp}
                </code>
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(`claude mcp add --transport http ponzu ${mcp}`);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className={muted}>
                Codex: <code className={code}>codex mcp add ponzu --url {mcp}</code> · Cursor:{" "}
                <code className={code}>ponzu install cursor</code>
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
