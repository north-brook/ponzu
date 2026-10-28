/**
 * Two signals that a page survived, for when the browser kills it without throwing anything.
 *
 * iOS Safari kills a tab that takes too much memory and reloads it ("This webpage was reloaded
 * because a problem occurred", then "A problem repeatedly occurred" if it keeps happening). No error
 * reaches the page, so error tracking never hears of it. sessionStorage lives outside the page's
 * process, so it outlives the crash: while the page is open and on screen it holds a marker, and
 * the page clears it whenever it's hidden or left. A load that finds the marker still there in the
 * same tab follows a crash, and says so with `page crashed`.
 *
 * `page ready` is the other half: the page stayed open and on screen for READY_MS after loading.
 * Pageviews against it, by OS and browser, show where pages die before then.
 */

export const MARKER = "ponzu:alive";
export const READY_MS = 5000;

export type Capture = (event: string, properties: Record<string, string | boolean>) => void;

type Marker = { page: string; ready: boolean };

/** Starts watching this page. Returns a function that moves the marker to the current path. */
export function watchHealth(capture: Capture, win: Window = window): () => void {
  const storage = sessionStorageOf(win);
  const doc = win.document;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const left = read(storage);
  if (left) capture("page crashed", { page: left.page, ready: left.ready });

  const mark = () => {
    if (doc.visibilityState === "hidden") return;
    write(storage, { page: win.location.pathname, ready });
  };
  const clear = () => {
    try {
      storage?.removeItem(MARKER);
    } catch {}
  };

  // Counts READY_MS on screen after the load event; going off screen starts the count again.
  const countToReady = () => {
    clearTimeout(timer);
    if (ready || doc.readyState !== "complete" || doc.visibilityState === "hidden") return;
    timer = setTimeout(() => {
      ready = true;
      capture("page ready", { page: win.location.pathname });
      mark();
    }, READY_MS);
  };

  const onVisibility = () => {
    if (doc.visibilityState === "hidden") clear();
    else mark();
    countToReady();
  };

  mark();
  countToReady();
  win.addEventListener("load", countToReady);
  doc.addEventListener("visibilitychange", onVisibility);
  // A page put in the back/forward cache isn't killed with it, and comes back with pageshow.
  win.addEventListener("pagehide", clear);
  win.addEventListener("pageshow", onVisibility);
  return mark;
}

function sessionStorageOf(win: Window): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    // Storage blocked by the browser's settings: no crash signal, nothing else changes.
    return null;
  }
}

function read(storage: Storage | null): Marker | null {
  try {
    const raw = storage?.getItem(MARKER);
    if (!raw) return null;
    const marker = JSON.parse(raw) as Partial<Marker>;
    return { page: String(marker.page ?? ""), ready: marker.ready === true };
  } catch {
    return null;
  }
}

function write(storage: Storage | null, marker: Marker) {
  try {
    storage?.setItem(MARKER, JSON.stringify(marker));
  } catch {}
}
