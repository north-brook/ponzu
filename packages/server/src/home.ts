import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Artboard,
  type Catalog,
  type CatalogAgent,
  type CatalogFile,
  type CatalogMachine,
  type Doc,
  findArtboard,
} from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import { Design } from "@ponzu/store";
import { FsAdapter } from "@ponzu/store/fs";
import { catalogFile, LocalCatalog, machineKind } from "./catalog.ts";
import {
  PREVIEW_FILE,
  type PreviewTheme,
  previewFile,
  previewStale,
  writePreview,
} from "./preview.ts";
import { ownerOf, readTailnet, type Tailnet } from "./tailnet.ts";
import type { LocalWorkspace } from "./workspace.ts";

/** How long the tailnet's peer list stays fresh. */
const TAILNET_TTL = 15_000;
/** How long a peer gets to answer for its catalog. */
const PEER_TIMEOUT = 2500;
/** Thumbnails kept in memory, newest last. */
const THUMBS = 200;

export interface HomeOptions {
  /** Folders always scanned for designs. */
  roots?: string[];
  spotlight?: boolean | "roots";
  /** Where to remember which guarded folders Ponzu may read. */
  stateFile?: string;
  /** List the owner's other Macs' designs over Tailscale. */
  tailnet: boolean;
  /** The agents Ponzu can set up here. */
  agents?: () => Promise<CatalogAgent[]>;
  /** This server's own URL, for rendering thumbnails with a design's assets. */
  self: () => string;
  /** The port the owner's other Macs serve their designs on. */
  peerPort: number;
  /** Designs the person named when starting the server, listed even if they're examples. */
  opened?: string[];
}

/**
 * Who asked to open a design. The person (the studio's Open, a card, Finder, the
 * app's Open Recent) lists it on the home screen even if it's an example; an
 * agent (`ponzu mcp` registering its project's designs) only makes it available.
 */
export type OpenedBy = "person" | "agent";

/**
 * The home screen's data: every design on this Mac and on the owner's other
 * Macs, their previews and artboard thumbnails, and a relay that lets this
 * Mac's studio open a design on another Mac.
 */
export class Home {
  readonly catalog: LocalCatalog;
  private tailnet: Promise<Tailnet | null> | null = null;
  private tailnetAt = 0;
  private owner: Promise<string | null> = Promise.resolve(null);
  private ownerAt = 0;
  private kind = machineKind();
  private created = new Map<string, number>();
  private agent: Catalog["agent"];
  private thumbs = new Map<string, Uint8Array>();
  private drawing = new Map<string, Promise<Uint8Array | null>>();

  constructor(
    private ws: LocalWorkspace,
    private opts: HomeOptions,
  ) {
    this.catalog = new LocalCatalog({
      roots: opts.roots,
      spotlight: opts.spotlight,
      stateFile: opts.stateFile,
    });
    for (const { key } of ws.designs()) this.catalog.add(key);
    for (const key of opts.opened ?? []) this.catalog.opened(key);
    ws.onOpen((key) => this.catalog.add(key));
    ws.onCreate((key) => {
      this.catalog.add(key);
      this.created.set(key, Date.now());
    });
    ws.presence.on((list) => {
      const latest = list
        .filter((p) => p.kind === "agent")
        .sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (latest)
        this.agent = { name: latest.name, ...(latest.client ? { client: latest.client } : {}) };
    });
  }

  /**
   * Open a design for someone. Opening it for the person lists it, examples
   * included, and an example they open stays listed after a restart.
   */
  async open(path: string, by: OpenedBy): Promise<{ key: string; design: Design }> {
    const opened = await this.ws.open(path);
    if (by === "person")
      this.catalog.opened(opened.key, { remember: Boolean(opened.design.doc.example) });
    return opened;
  }

  /** The owner's tailnet, re-read every few seconds. Null when Tailscale isn't running or is off. */
  net(): Promise<Tailnet | null> {
    if (!this.opts.tailnet) return Promise.resolve(null);
    if (this.tailnet && Date.now() - this.tailnetAt < TAILNET_TTL) return this.tailnet;
    this.tailnetAt = Date.now();
    this.tailnet = readTailnet().catch(() => null);
    return this.tailnet;
  }

  /**
   * Whether a request from this tailnet address is one of the owner's own
   * devices. Asks Tailscale even with listing off: a server bound past
   * loopback still hears the tailnet.
   */
  async trusted(ip: string): Promise<boolean> {
    if (Date.now() - this.ownerAt > TAILNET_TTL) {
      this.ownerAt = Date.now();
      this.owner = readTailnet()
        .then((n) => n?.user ?? null)
        .catch(() => null);
    }
    const owner = await this.owner;
    return owner !== null && (await ownerOf(ip)) === owner;
  }

  /** This Mac's designs, as another Mac or this one's studio sees them. */
  async local(): Promise<{ machine: CatalogMachine; files: CatalogFile[] }> {
    const open = new Map<string, Doc>(
      this.ws.designs().map(({ key, design }) => [key, design.doc]),
    );
    const busy = new Map<string, string>();
    for (const p of this.ws.presence.list()) {
      if (p.kind !== "agent" || !p.working.length) continue;
      for (const { key, design } of this.ws.designs())
        if (p.working.some((id) => findArtboard(design.doc, id)))
          busy.set(key, p.client ?? "other");
    }
    const files = (await this.catalog.files(open)).map((s) =>
      catalogFile(s, { busy: busy.get(s.key), created: this.created.get(s.key) }),
    );
    return { machine: { id: "local", name: "This Mac", kind: await this.kind }, files };
  }

  /** Everything the home screen lists: this Mac first, then each reachable peer. */
  async full(): Promise<Catalog> {
    const [here, net, agents] = await Promise.all([
      this.local(),
      this.net(),
      this.opts.agents?.() ?? Promise.resolve([]),
    ]);
    const machines: CatalogMachine[] = [here.machine];
    const files = [...here.files];
    const peers = (net?.peers ?? []).filter((p) => p.online);
    const remote = await Promise.all(peers.map((p) => this.peerCatalog(p.name, p.ip)));
    for (const r of remote) {
      if (!r) continue;
      machines.push(r.machine);
      files.push(...r.files);
    }
    files.sort((a, b) => b.modified - a.modified);
    return { machines, files, agents, ...(this.agent ? { agent: this.agent } : {}) };
  }

  /** A peer's own designs, with every URL routed through this server's relay. */
  private async peerCatalog(
    name: string,
    ip: string,
  ): Promise<{ machine: CatalogMachine; files: CatalogFile[] } | null> {
    try {
      const res = await fetch(`http://${ip}:${this.opts.peerPort}/api/catalog?scope=local`, {
        signal: AbortSignal.timeout(PEER_TIMEOUT),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { machine: CatalogMachine; files: CatalogFile[] };
      const base = `/peers/${encodeURIComponent(name)}`;
      const machine: CatalogMachine = { ...body.machine, id: name, name };
      return {
        machine,
        files: body.files.map((f) => ({
          ...f,
          id: `${name}:${f.key}`,
          machine: name,
          base,
          preview: f.preview && `${base}${f.preview}`,
          artboards: f.artboards.map((a) => ({ ...a, thumb: `${base}${a.thumb}` })),
        })),
      };
    } catch {
      return null;
    }
  }

  /** The tailnet address of a peer the studio named, if it's one of the owner's Macs. */
  async peerIp(name: string): Promise<string | null> {
    const net = await this.net();
    return net?.peers.find((p) => p.name === name)?.ip ?? null;
  }

  /**
   * A design's canvas preview, on the light or dark canvas, and only from a
   * design the catalog lists and may read. Drawn on request when it's missing,
   * or when a design that isn't open changed on disk since (a pull, another
   * Mac, an edit by hand): an open one redraws its own as it's edited.
   */
  async preview(key: string, theme: PreviewTheme = "light"): Promise<Uint8Array | null> {
    if (!(await this.listed(key))) return null;
    const file = join(key, previewFile(theme));
    const renderer = this.ws.renderer;
    if (renderer && (!existsSync(file) || (!this.ws.get(key) && (await previewStale(key)))))
      // One draw for both themes, whichever is asked for first.
      await this.once(`preview:${key}`, async () => {
        const doc = await this.doc(key);
        return Boolean(doc && (await writePreview(key, doc, renderer)));
      });
    // A draw that failed leaves the last preview, which beats none.
    if (existsSync(file)) return new Uint8Array(await readFile(file));
    // Drawn before there were dark previews, with nothing here to draw one now.
    const light = join(key, PREVIEW_FILE);
    return !renderer && existsSync(light) ? new Uint8Array(await readFile(light)) : null;
  }

  /** One artboard as a PNG, a few hundred pixels wide, for search results. */
  async thumb(key: string, artboardId: string, version: string): Promise<Uint8Array | null> {
    if (!(await this.listed(key))) return null;
    const renderer = this.ws.renderer;
    if (!renderer) return null;
    const id = `${key}\n${artboardId}\n${version}`;
    const hit = this.thumbs.get(id);
    if (hit) return hit;
    return this.once(`thumb:${id}`, async () => {
      const doc = await this.doc(key);
      const ab = doc && findArtboard(doc, artboardId)?.artboard;
      if (!doc || !ab) return null;
      const bytes = await drawThumb(
        renderer,
        ab,
        doc.tokens,
        `${this.opts.self()}/files/${encodeURIComponent(key)}`,
      );
      this.thumbs.set(id, bytes);
      if (this.thumbs.size > THUMBS) this.thumbs.delete(this.thumbs.keys().next().value!);
      return bytes;
    });
  }

  /** Whether the catalog lists this design and Ponzu may read it. */
  async listed(key: string): Promise<boolean> {
    return (
      Boolean(this.ws.get(key)) || ((await this.catalog.has(key)) && this.catalog.readable(key))
    );
  }

  /** The design's doc: live when it's open, else read from disk without opening it. */
  private async doc(key: string): Promise<Doc | null> {
    const open = this.ws.get(key);
    if (open) return open.doc;
    try {
      const design = await Design.open(new FsAdapter(key), { watch: false });
      const doc = design.doc;
      await design.close();
      return doc;
    } catch {
      return null;
    }
  }

  private once<T>(id: string, run: () => Promise<T>): Promise<T | null> {
    const pending = this.drawing.get(id) as Promise<T | null> | undefined;
    if (pending) return pending;
    const p = run()
      .catch(() => null)
      .finally(() => this.drawing.delete(id));
    this.drawing.set(id, p as Promise<Uint8Array | null>);
    return p;
  }
}

/** Long side of a thumbnail, in CSS px. It renders at 2x. */
const THUMB = 360;

async function drawThumb(
  renderer: Renderer,
  ab: Artboard,
  tokens: string,
  assetBase: string,
): Promise<Uint8Array> {
  const px = (v?: string) => (v && /px$/.test(v) ? Number.parseFloat(v) : 0);
  const w = px(ab.root.style.width) || 1440;
  const h = px(ab.root.style.height) || 900;
  const scale = Math.min(1, (THUMB * 2) / Math.max(w, Math.min(h, w * 2)));
  const out = await renderer.render({
    artboard: ab,
    tokens,
    scale,
    assetBase,
  });
  return out.bytes;
}
