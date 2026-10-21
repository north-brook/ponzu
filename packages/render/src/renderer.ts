import type { Artboard } from "@ponzu/core";
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
    | "missing-font";
  message: string;
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
}

export interface RenderResult {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  /** The artboard's actual content height, useful when its height is fit-content. */
  contentHeight: number;
  issues: LintIssue[];
  /** What animates and where the shot sits on the timeline. */
  motion?: MotionInfo;
}

/**
 * Turns an artboard into pixels. The server uses headless Chromium; the
 * desktop app can use an offscreen window; an embedding host can supply its own.
 */
export interface Renderer {
  render(req: RenderRequest): Promise<RenderResult>;
  /** Step through an animation and capture frames. Renderers without it can't record. */
  record?(req: RecordRequest): Promise<RecordResult>;
  close(): Promise<void>;
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
  for (const el of root.querySelectorAll('[data-id]')) {
    const id = el.getAttribute('data-id');
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
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
    if (el.parentElement && el.parentElement !== root.parentElement) {
      const p = el.parentElement.getBoundingClientRect();
      const pcs = getComputedStyle(el.parentElement);
      if (pcs.overflow !== 'visible' && cs.position !== 'absolute' && cs.position !== 'fixed' && (r.right > p.right + 1 || r.bottom > p.bottom + 1) && r.width > 2) {
        issues.push({ id, kind: 'overflow', message: label(el) + ' overflows ' + label(el.parentElement) });
      }
    }
  }
  if (!scrolls(root) && root.scrollHeight > root.clientHeight + 1) {
    issues.push({ id: root.getAttribute('data-id'), kind: 'overflow', message: 'content is ' + (root.scrollHeight - root.clientHeight) + 'px taller than the artboard; set height: fit-content or make room' });
  }
  return issues.slice(0, 30);
})()`;
