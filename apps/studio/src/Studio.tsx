import {
  type Catalog,
  type CatalogFile,
  type CatalogMachine,
  type Doc,
  findArtboard,
  type Presence,
  shelfRequest,
} from "@ponzu/core";
import {
  type AgentActivity,
  AgentMark,
  agentActivity,
  Canvas,
  Icon,
  Logo,
  ShortcutHint,
  SocketSource,
  timeAgo,
  useDelayed,
  useModifierHint,
  useSource,
} from "@ponzu/react";
import {
  Fragment,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dashboard, type OpenTarget, type ShelfAction } from "@/components/dashboard";
import { FileDetails, fileOf, tilde } from "@/components/file-info";
import { PairIphone } from "@/components/pair-iphone";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { UpdateButton } from "@/components/update";
import { watchCatalog } from "@/lib/catalog";
import { cn } from "@/lib/utils";

/** Where `ponzu serve` lives. Same origin in production; the dev server proxies. */
const ORIGIN = window.location.origin;
const mac = navigator.userAgent.includes("Mac");
/** The key the tab shortcuts go with, as their hints write it. */
const mod = mac ? "⌘" : "Ctrl";

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
      /** ⌘W from the app menu. Returns the unsubscribe. Missing from builds before tab closing. */
      onCloseTab?(handler: () => void): () => void;
      closeWindow?(): void;
      /** Ponzu › Pair iPhone…. Returns the unsubscribe. Missing from builds before pairing. */
      onPairIphone?(handler: () => void): () => void;
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
  /**
   * The artboard a link opened the window on (ponzu://open?file=…&artboard=…), in its file.
   * Dropped once the person moves to another tab, so coming back keeps where they were.
   */
  const [linked, setLinked] = useState(() => {
    const q = new URLSearchParams(location.search);
    const file = q.get("file");
    const artboard = q.get("artboard");
    return file && artboard ? { file, artboard } : null;
  });
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

  // The home screen's catalog, pushed as it changes, here and on the person's other Macs, so a
  // design an agent creates opens in a tab whichever screen is showing.
  useEffect(() => watchCatalog(ORIGIN, setCatalog), []);

  // A design an agent creates opens in a tab as soon as it exists, once, behind whatever the
  // person is looking at: switching to it would pull them out of their work. Not one it made
  // for its own use: that starts out archived, out of the way.
  const [seen] = useState(() => new Set<string>());
  /** The last design an agent opened that way, for the strip to scroll to. */
  const [arrived, setArrived] = useState<string | null>(null);
  useEffect(() => {
    if (!catalog) return;
    for (const f of catalog.files) {
      if (f.machine !== "local" || !f.created || seen.has(f.key)) continue;
      seen.add(f.key);
      // Decided once, on first sight: archiving or restoring it later doesn't open it.
      if (f.shelf && f.shelf !== "recent") continue;
      if (Date.now() - f.created > 60_000 || tabs.includes(f.key)) continue;
      setTabs((t) => (t.includes(f.key) ? t : [...t, f.key]));
      setArrived(f.key);
    }
  }, [catalog]);

  useEffect(() => {
    localStorage.setItem("ponzu.tabs", JSON.stringify(tabs));
    const url = new URL(location.href);
    if (active) url.searchParams.set("file", active);
    else url.searchParams.delete("file");
    if (linked && active !== linked.file) {
      setLinked(null);
      url.searchParams.delete("artboard");
    }
    history.replaceState(null, "", url);
  }, [tabs, active]);

  // Archive or restore, on the Mac the design is on: its server relays to another Mac's.
  // Shown now; the stream confirms it.
  const shelve = async (file: CatalogFile, action: ShelfAction) => {
    const res = await fetch(`${ORIGIN}${file.base}/api/shelf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: file.key, action: shelfRequest(file, action) }),
    });
    if (!res.ok)
      throw new Error(
        res.status === 502
          ? "That Mac isn’t answering. Try again once it’s back."
          : await res.text(),
      );
    setCatalog(
      (c) =>
        c && {
          ...c,
          files: c.files.map((f) =>
            f.id === file.id
              ? {
                  ...f,
                  shelf: action === "archive" ? "archived" : "recent",
                  archivedFor: action === "archive" ? "person" : undefined,
                }
              : f,
          ),
        },
    );
  };

  const openFile = async (target: OpenTarget) => {
    // A design here opens through the API, which lets the server read a guarded folder now
    // that the person asked for it. One on another Mac opens with its socket.
    if (!target.base)
      await fetch(`${ORIGIN}/api/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target.key, by: "person" }),
      });
    const tab = tabOf(target);
    setTabs((t) => (t.includes(tab) ? t : [...t, tab]));
    setActive(tab);
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

  const { strip, dragProps } = useTabDrag(tabs, setTabs);
  useEdgeFade(strip, tabs);
  // A design opened behind the person's tab scrolls into sight at the strip's end, where it
  // joined, so a full strip doesn't hide it.
  useEffect(() => {
    const s = strip.current;
    if (arrived && s) s.scrollTo({ left: s.scrollWidth, behavior: "smooth" });
  }, [arrived]);
  // Holding ⌘ turns the tabs' icons into the numbers that jump to them.
  const hint = useModifierHint(mac ? "Meta" : "Control");

  const desktop = window.ponzuDesktop;
  const isMac = desktop?.platform === "darwin";
  const isWindows = desktop?.platform === "win32";

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 px-2",
          desktop && "app-drag [&_button]:app-no-drag",
          // Electron on macOS: room for the traffic lights. Since macOS 26 they end at x=76;
          // this keeps the logo 19px clear of them.
          isMac && "pl-[88px]",
          // Electron on Windows: room for the caption buttons it draws over the header's right.
          isWindows &&
            "pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+8px)]",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Home"
          className={cn(
            "w-8",
            active === null && "bg-secondary text-foreground hover:bg-secondary",
          )}
          onClick={() => setActive(null)}
        >
          <ShortcutHint modifier={mod} n={0} shown={hint} center>
            {/* In the button's colour: quiet like the other tabs until it's the one you're on. */}
            <Logo size={18} color="currentColor" />
          </ShortcutHint>
        </Button>
        <div
          ref={strip}
          className="relative flex min-w-0 gap-0.5 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,#000_var(--fade-start,0px),#000_calc(100%_-_var(--fade-end,0px)),transparent)] [scrollbar-width:none]"
        >
          {tabs.map((key, i) => (
            <FileTab
              key={key}
              source={source(key)}
              file={fileOf(catalog, targetOf(key))}
              machines={catalog?.machines}
              shortcut={i < 8 ? i + 1 : i === tabs.length - 1 ? 9 : undefined}
              showShortcut={hint}
              active={key === active}
              onClick={() => setActive(key)}
              onClose={() => closeTab(key)}
              {...dragProps(key)}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <UpdateButton machines={catalog?.machines} origin={ORIGIN} />
          {active && <ActiveAgents source={source(active)} />}
        </div>
      </header>
      <main className="min-h-0 flex-1 px-2 pb-2">
        {active ? (
          <div className="h-full overflow-hidden rounded-xl bg-canvas" key={active}>
            <Canvas
              source={source(active)}
              theme={theme}
              me={{ kind: "user", name: "You" }}
              artboard={active === linked?.file ? linked.artboard : undefined}
            />
          </div>
        ) : (
          <Dashboard
            catalog={catalog}
            onOpen={(t) => void openFile(t)}
            onShelve={shelve}
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
      <PairIphone />
    </div>
  );
}

type DragProps = ReturnType<ReturnType<typeof useTabDrag>["dragProps"]>;

function FileTab({
  source,
  file,
  machines,
  shortcut,
  showShortcut,
  active,
  onClick,
  onClose,
  ...drag
}: {
  source: SocketSource;
  /** The catalog's entry for it: where it lives, its branch. */
  file?: CatalogFile;
  machines?: CatalogMachine[];
  shortcut?: number;
  /** ⌘ is held: the shortcut eases in over the icon. */
  showShortcut: boolean;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
} & DragProps) {
  const state = useSource(source);
  const working = state.presence.some((p) => agentActivity(p, state.path) === "working");
  const offline = state.status === "offline";
  // Quick loads and blips show nothing; only a wait you'd notice gets the spinner. A plain ring,
  // not the slice: a row of loading tabs would be a row of logos.
  const waiting = useDelayed(!state.doc || offline);
  const [held, setHeld] = useState(false);
  const name =
    state.doc?.name ??
    source.file
      .split("/")
      .pop()
      ?.replace(/\.design$/, "");
  const tab = (
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
      {...drag}
      onPointerDown={(e) => {
        setHeld(true);
        drag.onPointerDown(e);
      }}
      onPointerLeave={() => setHeld(false)}
    >
      {/*
       * The close button sits over the end of the label, which fades out under it. The padding,
       * taken back by the margin, keeps the mask clear of a shortcut hint wider than the icon.
       */}
      <span className="-ml-1.5 flex min-w-0 items-center gap-[7px] pl-1.5 group-focus-visible:[mask-image:linear-gradient(to_left,transparent_14px,#000_32px)] group-hover:[mask-image:linear-gradient(to_left,transparent_14px,#000_32px)]">
        <ShortcutHint modifier={mod} n={shortcut} shown={showShortcut} index={shortcut}>
          {waiting ? (
            <span
              className="grid size-3.5 shrink-0 place-items-center"
              title={offline ? "Reconnecting" : "Opening"}
            >
              <span
                className={cn(
                  "size-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent text-faint motion-reduce:animate-none",
                  offline && "[animation-duration:2s]",
                )}
              />
            </span>
          ) : (
            <Icon name={state.doc?.icon ?? "blank"} size={14} />
          )}
        </ShortcutHint>
        <span className={cn("truncate", working && "pz-shimmer")}>{name}</span>
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
  // Slow to open, so it stays out of the way of switching tabs; dragging closes it.
  // Radix also opens it on focus, which a clicked tab gets back whenever the
  // window does, so only keyboard focus counts.
  return (
    <HoverCard open={held ? false : undefined} openDelay={600} closeDelay={100}>
      <HoverCardTrigger
        asChild
        onFocus={(e) => {
          if (!e.currentTarget.matches(":focus-visible")) e.preventDefault();
        }}
      >
        {tab}
      </HoverCardTrigger>
      <HoverCardContent align="start" side="bottom">
        <FileDetails
          file={file}
          name={name}
          machine={machines?.find((m) => m.id === (file?.machine ?? "local"))}
        />
      </HoverCardContent>
    </HoverCard>
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

/** How far in the strip's edges fade once tabs are hidden past them. */
const FADE = 32;

/**
 * Fade the strip's edges where tabs are scrolled out of sight. Each fade grows with what's
 * hidden on its side, up to `FADE`, so it eases in and out as you scroll instead of snapping.
 */
function useEdgeFade(strip: RefObject<HTMLDivElement | null>, tabs: string[]) {
  useLayoutEffect(() => {
    const s = strip.current;
    if (!s) return;
    const update = () => {
      // A quarter of the strip at most: squeezed narrow, the fades would meet and hide it all.
      const most = Math.min(FADE, s.clientWidth / 4);
      const end = s.scrollWidth - s.clientWidth - s.scrollLeft;
      s.style.setProperty("--fade-start", `${Math.min(Math.max(s.scrollLeft, 0), most)}px`);
      s.style.setProperty("--fade-end", `${Math.min(Math.max(end, 0), most)}px`);
    };
    update();
    s.addEventListener("scroll", update, { passive: true });
    // The window resizing the strip, and tabs growing as their names load.
    const resize = new ResizeObserver(update);
    resize.observe(s);
    for (const c of s.children) resize.observe(c);
    return () => {
      s.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [strip, tabs]);
}

/**
 * The agents with you in this file: full color while working, half while
 * watching for your comments. Agents that are connected but idle, or busy in
 * another file, don't show.
 */
function ActiveAgents({ source }: { source: SocketSource }) {
  const { presence, path, doc } = useSource(source);
  // An agent watching counts as active for a while after each wait; re-check as time passes.
  const now = useNow(15_000);
  const agents = presence
    .map((p) => ({ p, activity: agentActivity(p, path, now) }))
    .filter((a) => a.activity);
  if (!agents.length) return null;
  return (
    <div className="flex gap-0.5 pr-1">
      {agents.map(({ p, activity }) => (
        <HoverCard key={p.id} openDelay={150} closeDelay={100}>
          <HoverCardTrigger asChild>
            <span
              className={cn(
                "app-no-drag grid size-6 cursor-default place-items-center rounded-md transition-opacity duration-200 hover:bg-accent",
                activity === "watching" && "opacity-50",
              )}
            >
              <AgentMark client={p.client} size={16} />
            </span>
          </HoverCardTrigger>
          <HoverCardContent>
            <SessionCard presence={p} activity={activity!} doc={doc} />
          </HoverCardContent>
        </HoverCard>
      ))}
    </div>
  );
}

/** Where an agent's session comes from. Read-only. */
function SessionCard({
  presence: p,
  activity,
  doc,
}: {
  presence: Presence;
  activity: AgentActivity;
  doc: Doc | null;
}) {
  const product = productName(p);
  const boards = doc
    ? p.working.map((id) => findArtboard(doc, id)?.artboard.name).filter(Boolean)
    : [];
  const facts: [string, ReactNode][] = [];
  if (p.origin?.cwd)
    facts.push([
      "Project",
      <span key="cwd" className={cn(code, "truncate")} title={p.origin.cwd}>
        {tilde(p.origin.cwd)}
      </span>,
    ]);
  facts.push([
    "Via",
    p.origin?.via === "bridge" ? (
      <span key="via">
        Terminal · <span className={code}>ponzu mcp</span>
      </span>
    ) : (
      "MCP over HTTP"
    ),
  ]);
  facts.push(["Since", `${timeAgo(p.since)}${timeAgo(p.since) === "now" ? "" : " ago"}`]);
  if (boards.length) facts.push(["On", boards.join(", ")]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-canvas">
          <AgentMark client={p.client} size={16} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <b className="font-semibold">{product}</b>
          <span className="truncate text-muted-foreground text-xs">
            {activity === "working"
              ? `Working${p.status ? ` · ${p.status}` : ""}`
              : "Watching for your comments"}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 border-t pt-2.5 text-xs">
        {facts.map(([label, value]) => (
          <Fragment key={label}>
            <span className="text-muted-foreground">{label}</span>
            <span className="flex min-w-0">{value}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** "Claude Code 2.1.0", from the MCP client's own name when it gave one. */
function productName(p: Presence): string {
  const raw = p.origin?.clientName;
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    "claude-ai": "Claude",
    codex: "Codex",
    "codex-mcp-client": "Codex",
    cursor: "Cursor",
    "cursor-vscode": "Cursor",
  };
  const name = raw ? (known[raw] ?? raw) : p.name;
  return p.origin?.clientVersion ? `${name} ${p.origin.clientVersion}` : name;
}

function useNow(every: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

const code = "font-mono text-xs";
