/*
 * Fingers on the canvas, turned into what they mean: a pan, a pinch, a tap, a double-tap or a
 * hold. Fed touch points and times, so it runs (and is tested) without a screen.
 */

export interface Point {
  x: number;
  y: number;
}

export interface GestureHandlers {
  /** A finger landed: anything still gliding stops. */
  down(): void;
  pan(dx: number, dy: number): void;
  /** Two fingers landed, centred here. */
  pinchStart(center: Point): void;
  /** Their spread since the pinch began, and where their centre is now. */
  pinch(scale: number, center: Point): void;
  /** Every finger is up after a pan or pinch: how fast the last one was moving, in px/ms. */
  release(v: Point, moved: { x: number; y: number; pinched: boolean }): void;
  tap(p: Point): void;
  doubleTap(p: Point): void;
  longPress(p: Point): void;
}

/** px a finger may wander and still be tapping or holding. */
export const SLOP = 10;
/** A hold this long, still, is a long-press. */
export const HOLD_MS = 500;
/** A tap is quicker than this. */
export const TAP_MS = 300;
/** A second tap this soon after the first, and this close, is a double-tap. */
export const DOUBLE_MS = 300;
export const DOUBLE_PX = 40;

type Schedule = (fn: () => void, ms: number) => () => void;

interface Sample {
  t: number;
  x: number;
  y: number;
}

export class Gestures {
  private touches = new Map<number, Point>();
  private start: (Point & { t: number }) | null = null;
  /** The finger that pans, and where it last was. */
  private panId: number | null = null;
  private last: Point | null = null;
  private moved = false;
  private pinched = false;
  /** A hold fired: the rest of this touch means nothing more. */
  private held = false;
  private pinchFrom: { dist: number } | null = null;
  private samples: Sample[] = [];
  private total = { x: 0, y: 0 };
  private cancelHold: (() => void) | null = null;
  private lastTap: (Point & { t: number }) | null = null;

  constructor(
    private on: GestureHandlers,
    private schedule: Schedule = (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  ) {}

  /** Fingers that landed. */
  touchStart(changed: { id: number; x: number; y: number }[], t: number) {
    const first = this.touches.size === 0;
    for (const c of changed) this.touches.set(c.id, { x: c.x, y: c.y });
    if (first) {
      this.on.down();
      const c = changed[0]!;
      this.start = { x: c.x, y: c.y, t };
      this.panId = c.id;
      this.last = { x: c.x, y: c.y };
      this.moved = false;
      this.pinched = false;
      this.held = false;
      this.total = { x: 0, y: 0 };
      this.samples = [{ t, x: c.x, y: c.y }];
      this.cancelHold?.();
      this.cancelHold = this.schedule(() => {
        this.cancelHold = null;
        if (this.moved || this.pinched || this.touches.size !== 1 || !this.start) return;
        this.held = true;
        this.on.longPress({ x: this.start.x, y: this.start.y });
      }, HOLD_MS);
    }
    if (this.touches.size >= 2 && !this.held) this.beginPinch();
  }

  touchMove(changed: { id: number; x: number; y: number }[], t: number) {
    for (const c of changed) if (this.touches.has(c.id)) this.touches.set(c.id, { x: c.x, y: c.y });
    if (this.held) return;
    if (this.pinchFrom && this.touches.size >= 2) {
      const [a, b] = this.pair();
      this.on.pinch(distance(a, b) / this.pinchFrom.dist, mid(a, b));
      return;
    }
    const p = this.panId !== null ? this.touches.get(this.panId) : undefined;
    if (!p || !this.last || !this.start) return;
    if (!this.moved && Math.hypot(p.x - this.start.x, p.y - this.start.y) > SLOP) {
      this.moved = true;
      this.cancelHold?.();
    }
    if (!this.moved) return;
    const dx = p.x - this.last.x;
    const dy = p.y - this.last.y;
    this.last = { ...p };
    this.total.x += dx;
    this.total.y += dy;
    this.samples.push({ t, x: p.x, y: p.y });
    if (this.samples.length > 12) this.samples.shift();
    if (dx || dy) this.on.pan(dx, dy);
  }

  /** Fingers that lifted, or that the system took away. */
  touchEnd(changed: { id: number }[], t: number) {
    for (const c of changed) this.touches.delete(c.id);
    if (this.touches.size >= 2) {
      if (this.pinchFrom) this.beginPinch();
      return;
    }
    if (this.touches.size === 1) {
      // Down to one finger: it carries on as a pan from where it is, without a jump.
      this.pinchFrom = null;
      const [id, p] = [...this.touches][0]!;
      this.panId = id;
      this.last = { ...p };
      this.samples = [{ t, ...p }];
      return;
    }
    this.cancelHold?.();
    this.cancelHold = null;
    const start = this.start;
    this.start = null;
    this.pinchFrom = null;
    if (!start || this.held) return;
    if (this.moved || this.pinched) {
      this.lastTap = null;
      this.on.release(this.pinched ? { x: 0, y: 0 } : velocity(this.samples, t), {
        ...this.total,
        pinched: this.pinched,
      });
      return;
    }
    if (t - start.t > TAP_MS) return;
    const p = { x: start.x, y: start.y };
    const prev = this.lastTap;
    if (prev && t - prev.t < DOUBLE_MS && Math.hypot(p.x - prev.x, p.y - prev.y) < DOUBLE_PX) {
      this.lastTap = null;
      this.on.doubleTap(p);
      return;
    }
    this.lastTap = { ...p, t };
    this.on.tap(p);
  }

  private beginPinch() {
    this.cancelHold?.();
    this.cancelHold = null;
    this.pinched = true;
    this.moved = true;
    const [a, b] = this.pair();
    this.pinchFrom = { dist: Math.max(1, distance(a, b)) };
    this.on.pinchStart(mid(a, b));
  }

  private pair(): [Point, Point] {
    const [a, b] = [...this.touches.values()];
    return [a!, b!];
  }
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * A finger's speed as it lifted, in px/ms, from its last tenth of a second. One that rested
 * before lifting has none.
 */
export function velocity(samples: Sample[], now: number): Point {
  const last = samples.at(-1);
  if (!last || now - last.t > 50) return { x: 0, y: 0 };
  const first = samples.find((s) => last.t - s.t <= 100) ?? last;
  const dt = last.t - first.t;
  if (dt < 8) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}
