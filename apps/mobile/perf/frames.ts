/*
 * What the person sees, frame by frame: each rAF's time, and the frames in which the camera (the
 * `.world` transform) actually changed. One definition for both probes: the harness's
 * (`probe.ts` injects this function's source into the page) and the canvas's own, on the phone
 * (`canvas/probe.ts`), which hears of each frame (`onFrame`). Self-contained, nothing from outside
 * its body, so its source runs alone.
 */
export function watchFrames(onFrame?: (t: number, moved: boolean) => void): {
  t: number[];
  moves: number[];
  stop(): void;
} {
  let on = true;
  let world = document.querySelector<HTMLElement>(".world");
  let last = world ? world.style.transform : "";
  const out = {
    t: [] as number[],
    moves: [] as number[],
    stop() {
      on = false;
    },
  };
  const loop = (t: number) => {
    if (!on) return;
    if (!world || !world.isConnected) world = document.querySelector<HTMLElement>(".world");
    const c = world ? world.style.transform : "";
    const moved = c !== last;
    out.t.push(t);
    if (moved) out.moves.push(t);
    last = c;
    requestAnimationFrame(loop);
    if (onFrame) onFrame(t, moved);
  };
  requestAnimationFrame(loop);
  return out;
}
