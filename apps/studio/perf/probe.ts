/*
 * What the harness puts in the page before the studio loads (an init script): a frame clock, a
 * count of React's commits, the browser's own event timings and long animation frames, and the
 * gestures the scenarios play. Everything is on `window.__pz`, read back with page.evaluate.
 *
 * Gestures are played from inside the page, one step a frame, rather than sent over CDP: an
 * input sent over CDP waits for the renderer to take it, so a slow page would be sent fewer
 * events and look faster than it is. A step a frame for a set number of frames is the same
 * gesture on any machine: the counts that come out of it (elements restyled, React commits)
 * don't depend on how fast the machine is, and the times do.
 */

/** The page's side of the harness, as `window.__pz`. */
export interface Probe {
  /** Every animation frame's timestamp since the probe started. */
  frames: number[];
  /** React commits since the page loaded. */
  commits: number;
  /** The browser's event timings (an input to the frame that showed it), for inputs that took 8 ms or more. */
  events: { name: string; start: number; duration: number }[];
  /**
   * Each key pressed: when, and how long from the key to just after the frame that followed it
   * was drawn (a task posted from that frame's animation callback runs once it is). Headless
   * Chrome's event timings wait on a screen it doesn't have; this waits only on the page.
   */
  keys: { start: number; ms: number }[];
  /** Long animation frames, as the browser reports them. */
  loafs: { start: number; duration: number; blocking: number }[];
  now(): number;
  /** Resolves on the next animation frame, with its time. */
  frame(): Promise<number>;
  /** Resolves after `n` frames in which nothing changed in `quiet()`; true unless it gave up. */
  settle(quiet: () => unknown, n?: number, ms?: number): Promise<boolean>;
  /**
   * A trackpad over the canvas: `perFrame` wheel events each frame for `frames` frames, each
   * `dy` (ctrl held: a pinch). The canvas zooms by exp(-dy / 100) per event.
   */
  wheel(frames: number, dy: number, ctrl: boolean, perFrame?: number): Promise<void>;
  /** Drag the element matched by `selector` sideways and back, `px` at most, one move a frame. */
  drag(selector: string, frames: number, px: number): Promise<{ moved: number }>;
  /** The canvas's scroll plane, which takes the wheel. */
  plane(): HTMLElement;
}

declare global {
  interface Window {
    __pz: Probe;
  }
}

/** The init script. A string, since it runs in the page before anything of ours is there. */
export const PROBE = `(() => {
  const pz = {
    frames: [],
    commits: 0,
    events: [],
    keys: [],
    loafs: [],
    now: () => performance.now(),
    frame: () => new Promise((resolve) => requestAnimationFrame(resolve)),
  };
  window.__pz = pz;
  const tick = (t) => {
    pz.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // React's commits, through the hook its devtools use: a production build calls it too. Only
  // counted, never walked, so it costs nothing measurable.
  let ids = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) { const id = ++ids; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot() { pz.commits++; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };

  addEventListener("keydown", (e) => {
    const start = e.timeStamp;
    requestAnimationFrame(() => {
      const after = new MessageChannel();
      after.port1.onmessage = () => pz.keys.push({ start, ms: performance.now() - start });
      after.port2.postMessage(0);
    });
  }, true);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        pz.events.push({ name: e.name, start: e.startTime, duration: e.duration });
    }).observe({ type: "event", durationThreshold: 8, buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        pz.loafs.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration });
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}

  pz.settle = async (quiet, n = 10, ms = 30000) => {
    const end = performance.now() + ms;
    let last = JSON.stringify(quiet());
    let still = 0;
    while (still < n) {
      if (performance.now() > end) return false;
      await pz.frame();
      const now = JSON.stringify(quiet());
      still = now === last ? still + 1 : 0;
      last = now;
    }
    return true;
  };

  pz.plane = () => {
    let el = document.querySelector("[data-pz-board]");
    while (el && getComputedStyle(el).overflow !== "scroll") el = el.parentElement;
    if (!el) throw new Error("No canvas on the page.");
    return el;
  };

  pz.wheel = async (frames, dy, ctrl, perFrame = 2) => {
    const el = pz.plane();
    const r = el.getBoundingClientRect();
    const init = {
      deltaX: 0, deltaY: dy, ctrlKey: ctrl, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
      bubbles: true, cancelable: true, composed: true,
    };
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < perFrame; i++) el.dispatchEvent(new WheelEvent("wheel", init));
      await pz.frame();
    }
  };

  pz.drag = async (selector, frames, px) => {
    const h = document.querySelector(selector);
    if (!h) throw new Error("Nothing to drag at " + selector);
    const r = h.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const send = (type, cx, target) => target.dispatchEvent(new PointerEvent(type, {
      clientX: cx, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true, composed: true,
    }));
    const before = h.getBoundingClientRect().x;
    let moved = 0;
    send("pointerdown", x, h);
    for (let f = 1; f <= frames; f++) {
      send("pointermove", x + Math.sin((f / frames) * Math.PI * 2) * px, document);
      await pz.frame();
      // Read once, at the drag's furthest point: a read every frame would force a layout of
      // its own and be measured as the app's.
      if (f === Math.round(frames / 4)) moved = Math.abs(h.getBoundingClientRect().x - before);
    }
    send("pointerup", x, document);
    return { moved };
  };
})();`;
