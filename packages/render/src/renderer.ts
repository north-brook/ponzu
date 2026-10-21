import { type Artboard, ROOT_DIRECTION_NOTE } from "@ponzu/core";
import type { FrameStep, Interaction, MotionInfo } from "./motion.ts";

export interface LintIssue {
  id: string;
  kind:
    | "overflow"
    | "clipped-text"
    | "zero-size"
    | "offscreen"
    | "broken-image"
    | "tiny-text"
    | "low-contrast"
    | "missing-keyframes"
    | "hidden-after-animation"
    | "no-state-style"
    | "missing-font"
    | "wrapped-text"
    | "flex-direction"
    | "artboard-overlap";
  message: string;
}

export interface MeasureRequest {
  artboard: Artboard;
  tokens: string;
  /** Nodes to measure; the artboard's own id measures the artboard. */
  ids: string[];
  colorScheme?: "light" | "dark";
  assetBase?: string;
}

/** A rendered box in CSS px, relative to the artboard's top left. */
export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** display: none or visibility: hidden. */
  hidden?: boolean;
}

export interface MeasureResult {
  /** By id; null when the node isn't in the rendered artboard. */
  boxes: Record<string, LayoutBox | null>;
  /**
   * The height the artboard's content needs, without squeezing anything.
   * null when no fixed height is enough (a child sized in % of it outgrows it).
   */
  contentHeight: number | null;
}

export interface RenderRequest {
  artboard: Artboard;
  tokens: string;
  /** Only this node (an id inside the artboard). */
  nodeId?: string;
  /** Device pixel ratio. 1 is enough to check layout. */
  scale?: number;
  format?: "png" | "jpeg" | "pdf";
  colorScheme?: "light" | "dark";
  /** Run the lint pass. */
  lint?: boolean;
  /** Milliseconds into the timeline. Default: once every finite animation has finished. */
  at?: number;
  /** Hover, focus or press a node first; `at` then counts from that moment. */
  interact?: Interaction;
  /** Base URL for this design's assets/ paths, when it differs from the renderer's own. */
  assetBase?: string;
}

export interface RecordRequest {
  artboard: Artboard;
  tokens: string;
  nodeId?: string;
  colorScheme?: "light" | "dark";
  interact?: Interaction;
  /** How many frames, spread evenly from `from` to `to`. Default 9. */
  frames?: number;
  /** Start of the timeline window in ms. Default 0. */
  from?: number;
  /** End in ms. Default: when everything settles, plus one loop of anything that repeats. */
  to?: number;
  /** Step through this node's scroll range instead of time, for scroll-driven animation. */
  scroll?: string;
  lint?: boolean;
  assetBase?: string;
}

export interface RecordResult {
  /** A contact sheet: every frame in a labeled grid, as one PNG. */
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  /** What each frame shows, in order. */
  steps: FrameStep[];
  motion: MotionInfo;
  /** Lint once everything has settled, in the requested state. */
  issues: LintIssue[];
  /** Fonts or images were still loading when their time ran out; frames may show fallbacks. */
  assetsTimedOut?: boolean;
}

export interface RenderResult {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  /** The artboard's actual content height, useful when its height is fit-content. */
  contentHeight: number;
  /**
   * Device pixels per CSS pixel in the image: the scale asked for, or less
   * when that image would have been too big for the GPU to draw.
   */
  scale?: number;
  issues: LintIssue[];
  /** What animates and where the shot sits on the timeline. */
  motion?: MotionInfo;
  /**
   * Fonts or images were still loading when their time ran out, so the
   * image may show fallbacks. Lint says which.
   */
  assetsTimedOut?: boolean;
  /**
   * Set when lint ran but the image couldn't be captured. `bytes` is then
   * empty, and `issues` still holds the lint.
   */
  captureError?: string;
}

/**
 * Turns an artboard into pixels. The server uses headless Chromium; the
 * desktop app can use an offscreen window; an embedding host can supply its own.
 */
export interface Renderer {
  render(req: RenderRequest): Promise<RenderResult>;
  /** Step through an animation and capture frames. Renderers without it can't record. */
  record?(req: RecordRequest): Promise<RecordResult>;
  /** Rendered boxes of some nodes, at rest. Renderers without it can't measure. */
  measure?(req: MeasureRequest): Promise<MeasureResult>;
  close(): Promise<void>;
}

/**
 * In-page: how tall an artboard's content is, against its height. Artboards
 * are flex columns, so content too tall for a fixed height first squeezes
 * children that can shrink (a 300px image renders 250px) and only then
 * overflows, and scrollHeight sees just the overflow. Measuring with the
 * root's children pinned at flex-shrink: 0 sees both. Scroll areas stay
 * unpinned: they're meant to hold less than they have.
 *
 * Returns { height, needed }: the artboard's height and the height its
 * content needs, found by trying it, since a child sized in % grows with the
 * artboard. needed is less than height when there's room to spare, and null
 * when the content keeps outgrowing it.
 */
const ARTBOARD_FIT = `((root) => {
  const height = root.getBoundingClientRect().height;
  const cs = getComputedStyle(root);
  const column = /flex/.test(cs.display) && cs.flexDirection.startsWith('column');
  const pinned = column ? [...root.children].filter((c) => !/auto|scroll/.test(getComputedStyle(c).overflowY)) : [];
  const keep = (el, prop) => [el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
  const saved = [keep(root, 'height'), ...pinned.map((c) => keep(c, 'flex-shrink'))];
  const still = document.createElement('style');
  still.textContent = '[data-artboard], [data-artboard] > * { transition: none !important }';
  document.head.appendChild(still);
  for (const c of pinned) c.style.setProperty('flex-shrink', '0', 'important');
  const over = () => Math.max(0, root.scrollHeight - root.clientHeight);
  let needed = height;
  let short = over();
  for (let i = 0; i < 4 && short > 1; i++) {
    needed += short;
    root.style.setProperty('height', needed + 'px', 'important');
    short = over();
  }
  if (short > 1) needed = null;
  else if (needed === height) {
    root.style.setProperty('height', 'fit-content', 'important');
    needed = Math.min(height, root.getBoundingClientRect().height);
  }
  for (const [el, prop, value, priority] of saved) el.style.setProperty(prop, value, priority);
  // Lay out the restored styles before transitions come back, so none starts.
  root.getBoundingClientRect();
  still.remove();
  return { height, needed };
})`;

/** In-page: rendered boxes of these ids relative to the artboard, and its content height. */
export function measureScript(ids: string[]): string {
  return `(() => {
  const root = document.querySelector('[data-artboard]');
  if (!root) return null;
  const rb = root.getBoundingClientRect();
  const r1 = (v) => Math.round(v * 10) / 10;
  const boxes = {};
  for (const id of ${JSON.stringify(ids)}) {
    const el = root.getAttribute('data-id') === id ? root : root.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!el) { boxes[id] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const box = { x: r1(r.left - rb.left), y: r1(r.top - rb.top), width: r1(r.width), height: r1(r.height) };
    if (cs.display === 'none' || cs.visibility === 'hidden') box.hidden = true;
    boxes[id] = box;
  }
  const { needed } = ${ARTBOARD_FIT}(root);
  return { boxes, contentHeight: needed === null ? null : Math.ceil(needed - 0.01) };
})()`;
}

/** Runs in the page. Finds layout problems an agent can't see in HTML. */
export const LINT_SCRIPT = `(() => {
  const issues = [];
  const root = document.querySelector('[data-artboard]');
  if (!root) return issues;
  const rb = root.getBoundingClientRect();
  const label = (el) => el.getAttribute('data-name') || el.tagName.toLowerCase();
  // Content scrolled out of a scroll container is meant to be out of view.
  const scrolls = (el) => { const o = getComputedStyle(el); return /auto|scroll/.test(o.overflowX + o.overflowY); };
  const inScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { if (scrolls(p)) return true; if (p === root) return false; } return false; };
  const MEDIA = /^(svg|img|canvas|video)$/i;
  // Which sides of rect a pass outside rect b, and by how much: "12px right, 4px bottom".
  const sides = (a, b, slack = 1) => {
    const out = [['left', b.left - a.left], ['top', b.top - a.top], ['right', a.right - b.right], ['bottom', a.bottom - b.bottom]].filter(([, d]) => d > slack);
    return out.map(([s, d]) => Math.round(d) + 'px ' + s).join(', ');
  };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  // Text or media that rect a lands on outside box, if any: what spilling out of box draws over.
  const covered = (a, box) => {
    const b = box.getBoundingClientRect();
    return [...root.querySelectorAll('[data-id]')].find((o) => {
      if (box.contains(o) || o.contains(box) || (o.parentElement.closest('svg') && o.tagName.toLowerCase() !== 'svg')) return false;
      if (!ownText(o) && !MEDIA.test(o.tagName)) return false;
      const c = o.getBoundingClientRect();
      const i = { left: Math.max(a.left, c.left), top: Math.max(a.top, c.top), right: Math.min(a.right, c.right), bottom: Math.min(a.bottom, c.bottom) };
      return i.right - i.left > 1 && i.bottom - i.top > 1 && sides(i, b) !== '';
    });
  };
  // A short label (a wordmark, button or nav item) beside others in one row,
  // squeezed onto a second line. Headlines and paragraphs wrap on purpose, so
  // only a few words at modest size, in a row of at least three items.
  const wrapsInRow = (el, cs) => {
    const p = el.parentElement;
    const pcs = getComputedStyle(p);
    const row = /flex/.test(pcs.display) ? !pcs.flexDirection.startsWith('column')
      : /grid/.test(pcs.display) && pcs.gridTemplateColumns.trim().split(/\\s+/).length > 2;
    if (!row || p.children.length < 3) return false;
    const text = el.textContent.trim();
    const size = parseFloat(cs.fontSize);
    if (text.length > 24 || text.split(/\\s+/).length > 3 || size > 40) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = [...range.getClientRects()].filter((c) => c.width > 0).map((c) => c.top).sort((a, b) => a - b);
    return tops.length > 1 && tops[tops.length - 1] - tops[0] > size * 0.6;
  };
  for (const el of root.querySelectorAll('[data-id]')) {
    const id = el.getAttribute('data-id');
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const hasText = ownText(el);
    if ((r.width === 0 || r.height === 0) && (hasText || el.tagName === 'IMG')) {
      issues.push({ id, kind: 'zero-size', message: label(el) + ' has zero ' + (r.width === 0 ? 'width' : 'height') });
      continue;
    }
    if (inScroller(el)) {
      if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0) issues.push({ id, kind: 'broken-image', message: 'image ' + (el.getAttribute('src') || '') + ' failed to load' });
      continue;
    }
    if (r.right < rb.left || r.left > rb.right || r.bottom < rb.top || r.top > rb.bottom) {
      if (cs.position !== 'absolute' || r.width > 0) issues.push({ id, kind: 'offscreen', message: label(el) + ' is outside the artboard' });
      continue;
    }
    if (hasText) {
      const clipX = el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible';
      const clipY = el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible';
      if ((clipX || clipY) && cs.textOverflow !== 'ellipsis' && !cs.webkitLineClamp?.match(/\\d/)) {
        issues.push({ id, kind: 'clipped-text', message: label(el) + ' text is clipped' });
      }
      const size = parseFloat(cs.fontSize);
      if (size > 0 && size < 9) issues.push({ id, kind: 'tiny-text', message: label(el) + ' text is ' + size + 'px' });
    }
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0) {
      issues.push({ id, kind: 'broken-image', message: 'image ' + (el.getAttribute('src') || '') + ' failed to load' });
    }
    const flows = cs.position !== 'absolute' && cs.position !== 'fixed';
    if (el.parentElement && el.parentElement !== root.parentElement) {
      const p = el.parentElement.getBoundingClientRect();
      const pcs = getComputedStyle(el.parentElement);
      if (pcs.overflow !== 'visible' && flows && (r.right > p.right + 1 || r.bottom > p.bottom + 1) && r.width > 2) {
        issues.push({ id, kind: 'overflow', message: label(el) + ' overflows ' + label(el.parentElement) });
      } else if (flows && MEDIA.test(el.tagName) && !el.parentElement.closest('svg')) {
        // A chart or image bigger than its slot draws over what's next to it. Inline wrappers don't bound it.
        let box = el.parentElement;
        while (box !== root && /^(inline|contents)$/.test(getComputedStyle(box).display)) box = box.parentElement;
        const out = box !== root && sides(r, box.getBoundingClientRect());
        const under = out && covered(r, box);
        if (under) issues.push({ id, kind: 'overflow', message: label(el) + ' sticks out of ' + label(box) + ' (' + out + ') over ' + label(under) });
      }
    }
    if (el.tagName.toLowerCase() === 'svg' && !el.parentElement.closest('svg') && cs.overflow === 'visible') {
      // overflow: visible lets drawing past the viewBox spill onto the page.
      const ink = [...el.querySelectorAll('*')].slice(0, 2000)
        .filter((c) => c instanceof SVGGraphicsElement && !c.closest('defs, clipPath, mask, marker, pattern, symbol'))
        .map((c) => c.getBoundingClientRect()).filter((c) => c.width || c.height);
      if (ink.length) {
        const u = { left: Math.min(...ink.map((c) => c.left)), top: Math.min(...ink.map((c) => c.top)), right: Math.max(...ink.map((c) => c.right)), bottom: Math.max(...ink.map((c) => c.bottom)) };
        const out = sides(u, r, 2);
        const under = out && covered(u, el);
        if (under) issues.push({ id, kind: 'overflow', message: label(el) + ' draws outside its box (' + out + ') over ' + label(under) + '; it has overflow: visible' });
      }
    }
    if (hasText && el.children.length === 0 && /^(normal|pre-line|pre-wrap|break-spaces)$/.test(cs.whiteSpace) && wrapsInRow(el, cs)) {
      issues.push({ id, kind: 'wrapped-text', message: label(el) + ' wraps onto two lines in its row; give it white-space: nowrap or more room' });
    }
  }
  // The root's own display: flex keeps the artboard's column, where HTML
  // written for plain CSS means a row: side-by-side panes stack. Inline style
  // only, since that's what the HTML said; flex-flow sets the longhand too.
  const unset = /flex/.test(root.style.display) && !root.style.flexDirection;
  if (unset) issues.push({ id: root.getAttribute('data-id'), kind: 'flex-direction', message: ${JSON.stringify(ROOT_DIRECTION_NOTE)} });
  if (!scrolls(root)) {
    const fit = ${ARTBOARD_FIT}(root);
    const short = fit.needed === null ? root.scrollHeight - root.clientHeight : Math.ceil(fit.needed - 0.01) - Math.round(fit.height);
    const fix = unset ? ', make room, or set flex-direction: row' : ' or make room';
    if (short > 1) issues.push({ id: root.getAttribute('data-id'), kind: 'overflow', message: fit.needed === null
      ? 'content is ' + short + 'px taller than the artboard, and a child sized in % of it grows with it; set height: fit-content' + fix
      : 'content needs ' + Math.ceil(fit.needed - 0.01) + 'px, ' + short + 'px more than the artboard; set height: fit-content' + fix });
  }
  return issues.slice(0, 30);
})()`;
