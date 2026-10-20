import { AgentMark, Canvas, Icon, Logo, SocketSource, useSource } from "@ponzu/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WhatsNew } from "@/components/whats-new";
import { cn } from "@/lib/utils";

/** Where `ponzu serve` lives. Same origin in production; the dev server proxies. */
const ORIGIN = window.location.origin;

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

function useTheme(): ["light" | "dark", (t: "light" | "dark") => void] {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const stored = localStorage.getItem("ponzu.theme") as "light" | "dark" | null;
  const [theme, setTheme] = useState<"light" | "dark">(
    stored ?? (media.matches ? "dark" : "light"),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [
    theme,
    (t) => {
      localStorage.setItem("ponzu.theme", t);
      setTheme(t);
    },
  ];
}

export function Studio() {
  const [theme, setTheme] = useTheme();
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
          title="Home"
        >
          <Logo size={18} dark={theme === "dark"} />
        </Button>
        <div className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((key) => (
            <FileTab
              key={key}
              source={source(key)}
              active={key === active}
              onClick={() => setActive(key)}
              onClose={() => closeTab(key)}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {active && <AgentDots source={source(active)} />}
          <Button
            variant="ghost"
            size="icon"
            className="w-[30px]"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
          </Button>
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
  active,
  onClick,
  onClose,
}: {
  source: SocketSource;
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
      title={source.file}
    >
      {busy ? (
        <span className="m-px size-3 animate-spin rounded-full border-[1.6px] border-current border-r-transparent [animation-duration:0.8s]" />
      ) : (
        <Icon name="file" size={14} />
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
          <p className={muted}>
            Ponzu speaks MCP. Point your agent at this server and ask it to design something.
          </p>
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
        </section>
      </div>
    </div>
  );
}
