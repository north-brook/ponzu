/*
 * A send from the create page: the composer travels from the foot of the main pane to its home
 * at the foot of the thread, as one object. First, last, invert, play with the browser's own
 * animations, as the sidebar's rows move (sidebar/row-motion.ts).
 *
 * Why not the View Transitions API: tried first (a spike, both composers named `composer`), its
 * travelling thing is a pair of pictures, the create composer's and the thread's, stretched to the
 * box between them and cross-faded: mid-way the prompt shrinks to a third of its size over a
 * swelling "Steer, or ask more", two composers in one box. Keeping the card whole and its
 * contents still means naming every part apart and painting the card on the group's
 * pseudo-element (its shadow then drawn twice at either end); and the pane opening beside it has
 * to be kept out of the snapshot (the root unnamed). Here the card, the + and the send button
 * are each one element that moves, measurable in a test like anything else.
 *
 * What travels: the card's surface (its ground, shadow and corners), changing size on the way;
 * the + and the send button, from their corners to theirs, which they keep all the way; what was
 * written, fixed at the width it was written at so nothing reflows, fading as it leaves (it is
 * the thread's first line now); and the thread composer's own words fading in as it arrives. The
 * send button turns into what the thread's composer shows in its place (Stop, while the agent
 * wakes) by fading through, in place.
 */

/** The parts of a composer that travel, marked on both composers. */
const CARD = "[data-composer-card]";
const ATTACH = "[data-composer-attach]";
const SEND = "[data-composer-send]";

/** On the root while the composer travels: the thread's own composer waits unseen (cloud.css). */
export const FLIGHT_ATTR = "data-composer-flight";

/** Every animation of a travel has this id, so a test can find them, hold them and step them. */
export const FLIGHT_ID = "composer-flight";

/** The travel's length, in panes: it starts with the pane opening and lands once it has settled. */
const FLIGHT_PANES = 1.75;

/** Where the create composer was, as it was, the moment it sent. */
export interface FlightOrigin {
  card: DOMRect;
  attach: DOMRect | null;
  send: DOMRect | null;
  /** The card's contents as they were (the words included), to fade from. */
  contents: HTMLElement;
  attachButton: HTMLElement | null;
  sendButton: HTMLElement | null;
  radius: string;
}

export interface Flight {
  /** Lands now: the travelling composer goes and the thread's shows where it is. */
  land(): void;
  /** Resolves once it has landed, however it did. */
  landed: Promise<void>;
}

const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;

export function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Measures the composer in `root` and takes a copy of it as it is, before the send hides it. Null
 * where there is nothing to travel: no composer, or reduced motion (the same end, at once).
 */
export function takeOff(root: Element | null): FlightOrigin | null {
  const card = root?.querySelector<HTMLElement>(CARD);
  if (!card || reducedMotion()) return null;
  const contents = card.cloneNode(true) as HTMLElement;
  // A copied field doesn't keep what was typed in it.
  const field = card.querySelector("textarea");
  const copied = contents.querySelector("textarea");
  if (field && copied) copied.value = field.value;
  const attachButton = card.querySelector<HTMLElement>(ATTACH);
  const sendButton = card.querySelector<HTMLElement>(SEND);
  return {
    card: card.getBoundingClientRect(),
    attach: rect(attachButton),
    send: rect(sendButton),
    contents,
    attachButton: attachButton?.cloneNode(true) as HTMLElement | null,
    sendButton: sendButton?.cloneNode(true) as HTMLElement | null,
    radius: getComputedStyle(card).borderRadius,
  };
}

/** The thread's composer card, where a travel lands. */
export function threadComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#thread ${CARD}`);
}

/** The travel's clock: `FLIGHT_PANES` of the panes' own, on the travel's easing (tokens.css). */
export function flightTiming(): { duration: number; easing: string } {
  const style = getComputedStyle(document.documentElement);
  const value = style.getPropertyValue("--dur-pane").trim();
  const pane = Number.parseFloat(value) * (/\ds$/.test(value) ? 1000 : 1) || 220;
  return {
    duration: Math.round(pane * FLIGHT_PANES),
    easing: style.getPropertyValue("--ease-travel").trim() || "ease-in-out",
  };
}

/**
 * How far across `el`, inside the thread's pane, still has to go to where it rests: the pane's
 * content is as wide as the open pane and rests against its far edge, so while the pane opens it
 * has its width less what is open still to come. Zero once open.
 */
function settledShift(el: HTMLElement): number {
  const content = el.closest<HTMLElement>("#thread");
  const panel = content?.parentElement;
  if (!content || !panel) return 0;
  const c = content.getBoundingClientRect();
  return panel.getBoundingClientRect().right - c.width - c.left;
}

const box = (r: DOMRect) => ({
  left: `${r.left}px`,
  top: `${r.top}px`,
  width: `${r.width}px`,
  height: `${r.height}px`,
});

/** A copy laid out as itself but inert, unseen by assistive tech, and drawn at `r`. */
function part(el: HTMLElement, r: DOMRect, name: string): HTMLElement {
  el.removeAttribute("id");
  el.setAttribute("aria-hidden", "true");
  el.dataset.flight = name;
  Object.assign(el.style, { position: "fixed", margin: "0", ...box(r) });
  return el;
}

/**
 * Flies the composer from `origin` to `target` (the thread's composer card, already where it
 * will rest: the rail holds its content still while it opens). A window resized or a pane's edge
 * taken hold of mid-way lands it at once, where the thread's composer now is.
 */
export function fly(origin: FlightOrigin, target: HTMLElement): Flight {
  const root = document.documentElement;
  const { duration, easing } = flightTiming();
  // Where it will rest once the pane has opened: the rail's content rides in on the pane's
  // leading edge and comes to rest flush with its trailing one, the window's (app-window.tsx).
  const by = settledShift(target);
  const at = (r: DOMRect | null) => r && new DOMRect(r.x + by, r.y, r.width, r.height);
  const to = at(target.getBoundingClientRect())!;
  const toAttach = at(rect(target.querySelector(ATTACH)));
  const toSendEl = target.querySelector<HTMLElement>(SEND);
  const toSend = at(rect(toSendEl));

  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  layer.dataset.flight = "layer";
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "40",
  });

  // The card's surface: its ground, shadow and corners, the one thing that changes size.
  const surface = document.createElement("div");
  surface.className = "bg-surface shadow-bar";
  part(surface, origin.card, "surface");
  surface.style.overflow = "hidden";
  surface.style.borderRadius = origin.radius;

  // What was written, at the size it was written: it fades as it leaves, and nothing reflows.
  const before = origin.contents;
  before.querySelectorAll<HTMLElement>(`${ATTACH}, ${SEND}`).forEach((el) => {
    el.style.visibility = "hidden";
  });
  Object.assign(before.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${origin.card.width}px`,
    height: `${origin.card.height}px`,
    margin: "0",
    background: "none",
    boxShadow: "none",
  });
  // The thread composer's own words, at its size, against the foot the two share.
  const after = target.cloneNode(true) as HTMLElement;
  after.querySelectorAll<HTMLElement>(`${ATTACH}, ${SEND}`).forEach((el) => {
    el.style.visibility = "hidden";
  });
  Object.assign(after.style, {
    position: "absolute",
    left: "0",
    bottom: "0",
    width: `${to.width}px`,
    height: `${to.height}px`,
    margin: "0",
    background: "none",
    boxShadow: "none",
    opacity: "0",
  });
  surface.append(before, after);
  layer.append(surface);

  const timing = { duration, easing, id: FLIGHT_ID, fill: "both" as const };
  const moves: Animation[] = [
    surface.animate(
      [
        { ...box(origin.card), borderRadius: origin.radius },
        { ...box(to), borderRadius: getComputedStyle(target).borderRadius },
      ],
      timing,
    ),
    // Linear in time, so how far each has faded doesn't hang on the travel's easing.
    before.animate([{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }], {
      ...timing,
      easing: "linear",
    }),
    after.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], {
      ...timing,
      easing: "linear",
    }),
  ];
  // The model's choice sits by the send button, and the card narrows from its right: it goes
  // first, before the button's corner closes over it.
  before.querySelectorAll<HTMLElement>('[aria-label^="Model:"]').forEach((el) => {
    moves.push(
      el.animate([{ opacity: 1 }, { opacity: 0, offset: 0.12 }, { opacity: 0 }], {
        ...timing,
        easing: "linear",
      }),
    );
  });

  // The + and the send button keep their corners all the way.
  if (origin.attachButton && origin.attach && toAttach) {
    const plus = part(origin.attachButton, origin.attach, "attach");
    layer.append(plus);
    moves.push(plus.animate([box(origin.attach), box(toAttach)], timing));
  }
  if (origin.sendButton && origin.send && toSend && toSendEl) {
    const holder = part(document.createElement("div"), origin.send, "send");
    const from = origin.sendButton;
    const into = toSendEl.cloneNode(true) as HTMLElement;
    for (const el of [from, into]) {
      el.removeAttribute("id");
      Object.assign(el.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
    }
    into.style.opacity = "0";
    holder.append(from, into);
    layer.append(holder);
    moves.push(
      holder.animate([box(origin.send), box(toSend)], timing),
      // Each holds its end to the landing: an animation without a last keyframe eases back to
      // the element's own opacity, and the arrow would come back just before Stop shows.
      from.animate(
        [{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.7 }, { opacity: 0 }],
        { ...timing, easing: "linear" },
      ),
      into.animate(
        [{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1, offset: 0.7 }, { opacity: 1 }],
        { ...timing, easing: "linear" },
      ),
    );
  }

  root.setAttribute(FLIGHT_ATTR, "");
  document.body.append(layer);

  let done = false;
  let resolve = () => {};
  const landed = new Promise<void>((r) => {
    resolve = r;
  });
  const land = () => {
    if (done) return;
    done = true;
    window.removeEventListener("resize", land);
    held.disconnect();
    for (const move of moves) move.cancel();
    layer.remove();
    root.removeAttribute(FLIGHT_ATTR);
    resolve();
  };
  // A pane's edge taken hold of (AppWindow marks the window while it is dragged).
  const held = new MutationObserver(() => {
    if (document.querySelector("[data-pane-drag]")) land();
  });
  held.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-pane-drag"],
  });
  window.addEventListener("resize", land);
  Promise.all(moves.map((move) => move.finished)).then(land, () => {});
  return { land, landed };
}
