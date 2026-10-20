/** An element in an artboard. Text lives in TextNode children. */
export interface PElement {
  kind: "el";
  id: string;
  tag: string;
  /** Foreign-content namespace. HTML elements omit it. */
  ns?: "svg" | "math";
  /** Layer name shown to people and agents (data-name). */
  name?: string;
  /** Attributes other than style, data-id and data-name, in source order. */
  attrs: Record<string, string>;
  /** Inline style declarations, kebab-case keys, in source order. */
  style: Record<string, string>;
  children: PNode[];
}

export interface PText {
  kind: "text";
  value: string;
}

export type PNode = PElement | PText;

/** A top-level frame on a page, stored as one HTML file. */
export interface Artboard {
  id: string;
  name: string;
  x: number;
  y: number;
  /** The artboard's own element. Its style holds width and height. */
  root: PElement;
}

export interface PageMeta {
  id: string;
  name: string;
  icon?: string;
}

export interface DesignMeta {
  ponzu: 1;
  name: string;
  pages: PageMeta[];
}

export interface Message {
  id: string;
  author: Author;
  text: string;
  createdAt: number;
}

export interface Author {
  kind: "user" | "agent";
  name: string;
}

export interface Thread {
  id: string;
  artboardId: string;
  /** The node the pin is attached to, if any. Falls back to the artboard. */
  nodeId?: string;
  /** Pin offset from the artboard's top-left corner, in artboard pixels. */
  x: number;
  y: number;
  status: "open" | "resolved";
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface Dropped {
  /** What was removed, for example `<script>` or `onclick on <button>`. */
  what: string;
}
