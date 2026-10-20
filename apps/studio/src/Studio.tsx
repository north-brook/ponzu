import { type Doc, findArtboard, type Presence } from "@ponzu/core";
import {
  type AgentActivity,
  AgentMark,
  agentActivity,
  Canvas,
  Icon,
  Juice,
  Logo,
  SocketSource,
  timeAgo,
  useDelayed,
  useSource,
} from "@ponzu/react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
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
          // Electron on macOS: room for the traffic lights.
          isMac && "pl-20",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className={cn("w-8", active === null && "bg-secondary hover:bg-secondary")}
          onClick={() => setActive(null)}
          title={`Home (${mod}0)`}
        >
          <Logo size={18} dark={theme === "dark"} />
        </Button>
        <div className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((key, i) => (
            <FileTab
              key={key}
              source={source(key)}
              shortcut={i < 8 ? i + 1 : i === tabs.length - 1 ? 9 : undefined}
              active={key === active}
              theme={theme}
              onClick={() => setActive(key)}
              onClose={() => closeTab(key)}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {active && <ActiveAgents source={source(active)} />}
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

function FileTab({
  source,
  shortcut,
  active,
  theme,
  onClick,
  onClose,
}: {
  source: SocketSource;
  shortcut?: number;
  active: boolean;
  theme: "light" | "dark";
  onClick: () => void;
  onClose: () => void;
}) {
  const state = useSource(source);
  const working = state.presence.some((p) => agentActivity(p, state.path) === "working");
  const offline = state.status === "offline";
  // Quick loads and blips show nothing; only a wait you'd notice gets the wedge.
  const waiting = useDelayed(!state.doc || offline);
  const name =
    state.doc?.name ??
    source.file
      .split("/")
      .pop()
      ?.replace(/\.design$/, "");
  return (
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
      title={shortcut ? `${source.file} (${mod}${shortcut})` : source.file}
    >
      {waiting ? (
        <span
          className="grid size-3.5 place-items-center"
          title={offline ? "Reconnecting" : "Opening"}
        >
          <Juice size={14} dark={theme === "dark"} dry={offline} />
        </span>
      ) : (
        <Icon name="file" size={14} />
      )}
      <span className={cn("truncate", working && "pz-shimmer")}>{name}</span>
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
  );
}

/**
 * The agents with you in this file: full color while working, half while
 * collaborating (waiting on your comments). Agents that are connected but
 * idle, or busy in another file, don't show.
 */
function ActiveAgents({ source }: { source: SocketSource }) {
  const { presence, path, doc } = useSource(source);
  // A collaborate loop counts as active for a while after each wait; re-check as time passes.
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
                activity === "collaborating" && "opacity-50",
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
        {p.origin.cwd.replace(/^\/Users\/[^/]+/, "~")}
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
              : "Collaborating · waiting for your comments"}
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

const heading = "mb-3 font-semibold text-[15px]";
const muted = "my-2 text-muted-foreground";
const code = "font-mono text-xs";

function Home({
  files,
  onOpen,
  theme,
}: {
  files: FileEntry[];
  onOpen: (key: string) => Promise<void>;
  theme: "light" | "dark";
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const slow = useDelayed(opening !== null);
  const open = (key: string) => {
    setOpening(key);
    onOpen(key).finally(() => setOpening(null));
  };
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
                  className={cn(
                    "flex items-center gap-3 border-b px-3.5 py-3 text-left transition-opacity last:border-b-0 hover:bg-accent",
                    slow && (opening === f.key ? "bg-accent" : "opacity-50"),
                  )}
                  disabled={opening !== null}
                  onClick={() => open(f.key)}
                >
                  <span className="grid size-9 place-items-center rounded-[9px] bg-canvas">
                    {slow && opening === f.key ? (
                      <Juice size={20} dark={theme === "dark"} />
                    ) : (
                      <Icon name="file" size={18} />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="font-semibold">{f.name}</b>
                    <span className="truncate text-muted-foreground text-xs">
                      {slow && opening === f.key
                        ? "Opening…"
                        : f.key.replace(/^\/Users\/[^/]+/, "~")}
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
