/**
 * What the home screen shows: every .design on this Mac and on the person's
 * other Macs in their tailnet, newest edit first. `GET /api/catalog`.
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
  /** When an agent created it, if that happened since this server started. */
  created?: number;
  pages: { id: string; name: string; icon?: string }[];
  artboards: CatalogArtboard[];
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
