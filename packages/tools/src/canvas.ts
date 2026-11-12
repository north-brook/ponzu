import type { Doc, Op, Origin } from "@ponzu/core";

/** What applying an op tells the tools. */
export interface Applied {
  /** The artboards the op touched, deleted ones included. */
  artboards: string[];
}

/**
 * One canvas as the tools reach it: the document, and a way to change it. Where the canvas is
 * kept is the host's business. In the cloud it is a `ReplicaCanvas`, on a replica that syncs
 * with the API; the local server hands over store's `Design`, which is a folder of files.
 */
export interface ToolCanvas {
  /**
   * The canvas as it is now. Read it again after every `await`: a canvas that syncs swaps the
   * whole object when other people's changes land, so one held across an await can be stale.
   */
  readonly doc: Doc;
  /**
   * Apply an op at once, in `origin`'s name, and say what it touched. It never waits on
   * storage or the network. Throws, and changes nothing, when the op doesn't fit the document.
   *
   * A host may apply less than it was given: the cloud leaves out what a canvas can't hold
   * (script, mostly), and says what through the workspace's `notices`. So read `doc` for what
   * an edit left; don't assume it is the op.
   */
  apply(op: Op, origin: Origin): Applied;
}

/** A canvas a host has open, under the key the host knows it by. */
export interface OpenCanvas {
  key: string;
  canvas: ToolCanvas;
}
