import { AgentMark, Canvas, Icon, Logo, SocketSource, useSource } from "@ponzu/react";
import { useEffect, useMemo, useState } from "react";

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
    <div
      className={`studio studio-${theme} ${desktop ? "studio-desktop" : ""} ${isMac ? "studio-mac" : ""}`}
    >
      <header className="studio-bar">
        <button
          type="button"
          className={`studio-home ${active === null ? "on" : ""}`}
          onClick={() => setActive(null)}
          title="Home"
        >
          <Logo size={18} dark={theme === "dark"} />
        </button>
        <div className="studio-tabs">
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
        <div className="studio-bar-right">
          {active && <AgentDots source={source(active)} />}
          <button
            type="button"
            className="studio-icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
          </button>
        </div>
      </header>
      <main className="studio-main">
        {active ? (
          <div className="studio-file" key={active}>
            <Canvas source={source(active)} theme={theme} me={{ kind: "user", name: "You" }} />
          </div>
        ) : (
          <Home files={files} onOpen={openFile} theme={theme} />
        )}
      </main>
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
      className={`studio-tab ${active ? "on" : ""}`}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      role="tab"
      tabIndex={0}
      title={source.file}
    >
      {busy ? <span className="studio-spinner" /> : <Icon name="file" size={14} />}
      <span className="studio-tab-name">{name}</span>
      {state.status === "offline" && <span className="studio-offline" title="Reconnecting" />}
      <button
        type="button"
        className="studio-tab-close"
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
    <div className="studio-agents">
      {agents.map((a) => (
        <span
          key={a.id}
          className="studio-agent"
          title={`${a.name}${a.working.length ? " · working" : a.status ? ` · ${a.status}` : " · connected"}`}
        >
          <AgentMark client={a.client} size={16} />
          <span className={`studio-agent-dot ${a.working.length ? "busy" : ""}`} />
        </span>
      ))}
    </div>
  );
}

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
    <div className="home">
      <div className="home-inner">
        <div className="home-head">
          <Logo size={40} dark={theme === "dark"} />
          <h1>Ponzu</h1>
        </div>

        <section>
          <h2>Files</h2>
          {files.length === 0 ? (
            <p className="home-muted">
              No .design files yet. Ask your agent to create one, or run <code>ponzu init</code>.
            </p>
          ) : (
            <div className="home-files">
              {files.map((f) => (
                <button
                  type="button"
                  key={f.key}
                  className="home-file"
                  onClick={() => onOpen(f.key)}
                >
                  <span className="home-file-icon">
                    <Icon name="file" size={18} />
                  </span>
                  <span className="home-file-text">
                    <b>{f.name}</b>
                    <span>{f.key.replace(/^\/Users\/[^/]+/, "~")}</span>
                  </span>
                  {f.artboards !== undefined && (
                    <span className="home-muted">{f.artboards} artboards</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <form
            className="home-open"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) onOpen(path.trim());
            }}
          >
            {desktop ? (
              <>
                <button
                  type="button"
                  className="home-btn"
                  onClick={async () => {
                    const picked = await desktop.openFolder();
                    if (picked) onOpen(picked);
                  }}
                >
                  Open…
                </button>
                <button
                  type="button"
                  className="home-btn"
                  onClick={async () => {
                    const created = await desktop.newFile();
                    if (created) onOpen(created);
                  }}
                >
                  New…
                </button>
              </>
            ) : null}
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/name.design"
            />
            <button type="submit" className="home-btn">
              Open
            </button>
          </form>
        </section>

        <section>
          <h2>Connect an agent</h2>
          <p className="home-muted">
            Ponzu speaks MCP. Point your agent at this server and ask it to design something.
          </p>
          <div className="home-code">
            <code>claude mcp add --transport http ponzu {mcp}</code>
            <button
              type="button"
              className="home-btn"
              onClick={() => {
                navigator.clipboard.writeText(`claude mcp add --transport http ponzu ${mcp}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="home-muted">
            Codex: <code>codex mcp add ponzu --url {mcp}</code> · Cursor:{" "}
            <code>ponzu install cursor</code>
          </p>
        </section>
      </div>
    </div>
  );
}
