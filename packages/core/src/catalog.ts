import type { MachineUpdate } from "./update.ts";

/**
 * What the home screen shows: every .design on this Mac and on the person's
 * other Macs in their tailnet, newest edit first. `GET /api/catalog`, or as it
 * changes from `/api/catalog/stream` (see CatalogMessage).
 */
export interface Catalog {
  machines: CatalogMachine[];
  files: CatalogFile[];
  /** Agents Ponzu sets up on this Mac. */
  agents: CatalogAgent[];
  /** The agent that last called Ponzu here since it started. */
  agent?: { name: string; client?: string };
}

export interface CatalogMachine {
  /** "local" for this Mac, the tailnet host name for the others. */
  id: string;
  /** "This Mac", or the tailnet host name. */
  name: string;
  kind: "laptop" | "desktop";
  /** Its Mac app's updater. Missing for `ponzu serve`, and from apps before updates spread. */
  update?: MachineUpdate;
}

export interface CatalogFile {
  /** `${machine}:${key}`, unique across machines. */
  id: string;
  /** Absolute path of the .design folder on its machine. */
  key: string;
  name: string;
  /** CatalogMachine id. */
  machine: string;
  /**
   * Path prefix, on the studio's own origin, of the server that hosts the
   * file: "" for this Mac, `/peers/<machine>` for another, which this Mac's
   * server relays over the tailnet. Its socket and assets live under it.
   */
  base: string;
  /** Last edit, ms since the epoch. */
  modified: number;
  /** URL of the canvas preview. Null for a locked design. */
  preview: string | null;
  /**
   * In a folder macOS guards (Desktop, Documents, Downloads) that Ponzu hasn't
   * been let into yet: listed by name, without pages or a preview, until the
   * person opens a design there.
   */
  locked?: boolean;
  /** The agent editing it right now (its client: claude, openai, …). */
  busy?: string;
  /** The agents in it now, working or watching. Missing from Macs on older versions. */
  agents?: CatalogFileAgent[];
  /** When an agent created it, if that happened since this server started. */
  created?: number;
  /** The git checkout it's in, if any. Not read for a locked design. */
  git?: CatalogGit;
  /**
   * Which view lists it: Recent, or Archived (see `archivedFor`). Missing from
   * Macs on older versions, which means Recent. Older versions also send
   * Scratch, for a file an agent made for its own use, which shows as Archived.
   */
  shelf?: CatalogShelf;
  /** Why an archived design is archived. Missing from Macs on older versions. */
  archivedFor?: ArchiveReason;
  /** When the person archived it, on an archived design. */
  archived?: number;
  /** When it was last opened or edited, on a design archived for being idle. */
  active?: number;
  /**
   * A hash of what's in it: design.json, tokens, comments and artboards.
   * Checkouts of one repository carry identical copies of its designs, and
   * these say which. Missing for a locked design, and from older versions.
   */
  fingerprint?: string;
  pages: { id: string; name: string; icon?: string }[];
  artboards: CatalogArtboard[];
}

export type CatalogShelf = "recent" | "scratch" | "archived";

/**
 * How a design came to be archived: the person put it away, nobody opened or
 * edited it for a while, an agent made it for its own use (`"scratch": true`),
 * or it's in a folder the system empties (/tmp).
 */
export type ArchiveReason = "person" | "idle" | "scratch" | "temp";

/** The view a design shows in. An older Mac's Scratch is Archived. */
export function viewOf(file: Pick<CatalogFile, "shelf">): "recent" | "archived" {
  return file.shelf && file.shelf !== "recent" ? "archived" : "recent";
}

/**
 * What to send `/api/shelf` to archive or restore a design. An older Mac's
 * restore leaves a scratch design on Scratch; its "recent" is what brings one
 * to Recent, and this version takes "recent" as a restore too.
 */
export function shelfRequest(
  file: Pick<CatalogFile, "shelf">,
  action: "archive" | "restore",
): "archive" | "restore" | "recent" {
  return action === "restore" && file.shelf === "scratch" ? "recent" : action;
}

export interface CatalogGit {
  /** The checkout's top folder (a worktree's own, for a worktree). */
  root: string;
  /** The branch checked out there. Missing when HEAD is detached. */
  branch?: string;
  /** HEAD's short commit, when it's detached. */
  commit?: string;
  /** A linked worktree, not the repository's main checkout. Missing from Macs on older versions. */
  worktree?: boolean;
  /**
   * A worktree's copy as its branch found it: nothing in the design has
   * changed there since the branch left the default one, committed or not.
   * Missing until git has said, and from Macs on older versions.
   */
  untouched?: boolean;
  /**
   * The repository every checkout of it shares: its origin remote, as
   * `host/owner/name`, or without one, the main checkout's folder.
   */
  project?: string;
  /** The project's short name, e.g. "ponzu". */
  projectName?: string;
}

export interface CatalogArtboard {
  id: string;
  name: string;
  /** Page id. */
  page: string;
  /** URL of a PNG of this artboard. */
  thumb: string;
}

export interface CatalogAgent {
  id: string;
  label: string;
  /** Installed on this Mac. */
  found: boolean;
  /** Ponzu is registered with it. */
  connected: boolean;
}

/** A card on the home screen: a design, and the identical copies folded into it. */
export interface CatalogCard {
  file: CatalogFile;
  /** Other checkouts of the same project holding the same design, unchanged. Newest first. */
  copies: CatalogFile[];
}

/**
 * The designs worth a card. Every worktree of a repository carries its
 * designs, so a run of agents in eight worktrees would list each nine times.
 * A worktree's copy nobody has touched since its branch began, with no agent
 * in it, is the repository's design and nothing more. It isn't listed while
 * the main checkout holds the design (on any shelf) or another copy is the
 * same; failing both, the newest such copy stands for the rest.
 */
export function withoutUntouched(files: CatalogFile[]): CatalogFile[] {
  const quiet = (f: CatalogFile) => f.git?.untouched && !f.busy && !f.agents?.length;
  // Where a design is in its repository, on its Mac.
  const place = (f: CatalogFile) =>
    f.git && [f.machine, f.git.project ?? f.git.root, f.key.slice(f.git.root.length)].join("\0");
  const covered = new Set<string | undefined>();
  for (const f of files) {
    if (f.git?.worktree === false) covered.add(place(f));
    if (!quiet(f) && f.fingerprint) covered.add(`${place(f)}\0${f.fingerprint}`);
  }
  return files.filter((f) => {
    if (!quiet(f)) return true;
    const at = place(f);
    if (covered.has(at) || covered.has(`${at}\0${f.fingerprint}`)) return false;
    covered.add(at);
    return true;
  });
}

/**
 * One card per design, however many checkouts of its repository hold it.
 * Copies fold together while they're identical, on the same Mac and shelf; the
 * newest is the card. A copy someone changes, or an agent is in, gets its own
 * card. `files` is newest first, and so is what comes back.
 */
export function foldCopies(files: CatalogFile[]): CatalogCard[] {
  const cards: CatalogCard[] = [];
  const by = new Map<string, CatalogCard>();
  for (const file of files) {
    const project = file.git?.project ?? file.git?.root;
    const key =
      project && file.fingerprint && !file.busy && !file.agents?.length && !file.locked
        ? [file.machine, project, file.shelf ?? "recent", file.fingerprint].join("\0")
        : null;
    const card = key ? by.get(key) : undefined;
    if (card) {
      card.copies.push(file);
      continue;
    }
    const fresh: CatalogCard = { file, copies: [] };
    cards.push(fresh);
    if (key) by.set(key, fresh);
  }
  return cards;
}

/** An agent in a design, as its card shows it. */
export interface CatalogFileAgent {
  /** The agent's session. */
  id: string;
  name: string;
  /** Its product, for the icon: claude, openai, … */
  client?: string;
  /** What it said it's doing, from set_status. */
  status?: string;
  activity: "working" | "watching";
}

/**
 * `/api/catalog/stream`, a WebSocket: the catalog as it changes. A snapshot on
 * connecting, then a patch per change. `?scope=local`, and every other Mac,
 * gets this Mac's designs alone. A ping every few seconds says it's alive.
 */
export type CatalogMessage =
  | { t: "snapshot"; catalog: Catalog }
  | { t: "patch"; patch: CatalogPatch }
  | { t: "ping" };

/** What changed in a catalog. Only what's here changed. */
export interface CatalogPatch {
  /** Files new or changed, whole. */
  put?: CatalogFile[];
  /** Ids of files gone. */
  drop?: string[];
  /** Every machine, when the list changed. */
  machines?: CatalogMachine[];
  agents?: CatalogAgent[];
  agent?: Catalog["agent"];
}

/** The catalog after a patch, newest edit first. */
export function applyCatalogPatch(catalog: Catalog, patch: CatalogPatch): Catalog {
  const files = new Map(catalog.files.map((f) => [f.id, f]));
  for (const id of patch.drop ?? []) files.delete(id);
  for (const f of patch.put ?? []) files.set(f.id, f);
  return {
    ...catalog,
    files: patch.put?.length || patch.drop?.length ? sortFiles([...files.values()]) : catalog.files,
    ...(patch.machines ? { machines: patch.machines } : {}),
    ...(patch.agents ? { agents: patch.agents } : {}),
    ...(patch.agent ? { agent: patch.agent } : {}),
  };
}

/** Newest edit first. */
export function sortFiles(files: CatalogFile[]): CatalogFile[] {
  return files.sort((a, b) => b.modified - a.modified);
}
