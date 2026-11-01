/**
 * A board's scene script on the canvas: compiled into Web Animations by the
 * same runtime the renderer uses (render/src/act.ts), so the canvas plays
 * what record films. It plays from the moment the board renders, with the
 * board's other animations. Under reduced motion it holds its poster frame.
 */

import { ACT_TYPE, type ActSummary, actCore, actRuntime } from "@ponzu/render";

interface Scene {
  readonly animations: Animation[];
  readonly summary: ActSummary;
  cancel(): void;
  rebuild(): void;
}

const scenes = new WeakMap<ShadowRoot, { scene: Scene; stop: () => void }>();

function runtime(): { mount(section: HTMLElement): Scene | null } {
  const w = window as unknown as { __ponzuAct?: { mount(section: HTMLElement): Scene | null } };
  if (!w.__ponzuAct) actRuntime(actCore());
  return w.__ponzuAct!;
}

/** Play the board's scene, if it has one. Call each time the root's content is replaced. */
export function playScene(root: ShadowRoot) {
  stopScene(root);
  const section = root.querySelector<HTMLElement>("[data-artboard]");
  if (!section?.querySelector(`script[type="${ACT_TYPE}"]`)) return;
  let scene: Scene | null;
  try {
    scene = runtime().mount(section);
  } catch (e) {
    // A scene that can't compile leaves the board as its HTML draws it.
    console.warn("ponzu: scene script failed", e);
    return;
  }
  if (!scene) return;
  const s = scene;
  const still = () => {
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) return;
    for (const a of s.animations) {
      a.currentTime = s.summary.poster;
      a.pause();
    }
  };
  still();
  // Fonts and images that arrive later move what the scene measured: compile it again, at
  // the same moment of its timeline.
  let frame = 0;
  let live = true;
  const again = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!live) return;
      try {
        s.rebuild();
        still();
      } catch {}
    });
  };
  // An image's first load can move things; the sharper copies the canvas swaps in later keep its size.
  const seen = new WeakSet<EventTarget>();
  const loaded = (e: Event) => {
    if (!e.target || seen.has(e.target)) return;
    seen.add(e.target);
    again();
  };
  if (document.fonts?.status === "loading") void document.fonts.ready.then(again);
  section.addEventListener("load", loaded, true);
  scenes.set(root, {
    scene: s,
    stop: () => {
      live = false;
      cancelAnimationFrame(frame);
      section.removeEventListener("load", loaded, true);
      s.cancel();
    },
  });
}

export function stopScene(root: ShadowRoot) {
  scenes.get(root)?.stop();
  scenes.delete(root);
}

/** The scene's animations, for code that holds or phases a board's animations. */
export function sceneAnimations(root: ShadowRoot): Animation[] {
  return scenes.get(root)?.scene.animations ?? [];
}
