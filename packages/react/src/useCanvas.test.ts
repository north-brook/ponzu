import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Camera, type CameraView, cameraStore, followView } from "./useCanvas.ts";

/** Animation frames, run by hand: requested callbacks by id. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const raf = globalThis.requestAnimationFrame;
const caf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  frames = new Map();
  globalThis.requestAnimationFrame = (cb) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
});
afterEach(() => {
  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = caf;
});

const runFrame = () => {
  const due = [...frames.values()];
  frames = new Map();
  for (const cb of due) cb(0);
};

test("camera changes in one frame reach subscribers once, with the latest camera", () => {
  const store = cameraStore({ x: 0, y: 0, zoom: 1 });
  const seen: Camera[] = [];
  store.subscribe((c) => seen.push(c));
  for (let i = 0; i < 5; i++) store.set((c) => ({ ...c, x: c.x + 10 }));
  expect(store.get().x).toBe(50);
  expect(seen).toEqual([]);
  runFrame();
  expect(seen).toEqual([{ x: 50, y: 0, zoom: 1 }]);
  runFrame();
  expect(seen.length).toBe(1);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the camera view changes on a gesture's start, when the key changes, and once at rest", async () => {
  const store = cameraStore({ x: 0, y: 0, zoom: 1 });
  const seen: CameraView[] = [];
  // The key: the zoom in whole octaves.
  const stop = followView(
    store,
    (c) => String(Math.round(Math.log2(c.zoom))),
    (v) => seen.push(v),
    20,
  );
  expect(seen).toEqual([{ x: 0, y: 0, zoom: 1, moving: false }]);
  // Panning: one view as it starts moving, none for later frames with the same key.
  for (let i = 1; i <= 3; i++) {
    store.set((c) => ({ ...c, x: i }));
    runFrame();
  }
  expect(seen.length).toBe(2);
  expect(seen[1]).toMatchObject({ x: 1, moving: true });
  // Zooming past an octave: a view for the new key.
  store.set((c) => ({ ...c, zoom: 2.1 }));
  runFrame();
  expect(seen.length).toBe(3);
  expect(seen[2]).toMatchObject({ zoom: 2.1, moving: true });
  // At rest: the camera as it is, not moving.
  await wait(40);
  expect(seen.at(-1)).toEqual({ x: 3, y: 0, zoom: 2.1, moving: false });
  stop();
});

test("an immediate change flushes now and drops the pending frame", () => {
  const store = cameraStore({ x: 0, y: 0, zoom: 1 });
  const seen: Camera[] = [];
  store.subscribe((c) => seen.push(c));
  store.set((c) => ({ ...c, x: 5 }));
  store.set({ x: 1, y: 2, zoom: 0.5 }, true);
  expect(seen).toEqual([{ x: 1, y: 2, zoom: 0.5 }]);
  runFrame();
  expect(seen.length).toBe(1);
});

test("useCamera keeps its shape: the camera as state, with setCamera and cameraRef", async () => {
  const { useCamera } = await import("./useCanvas.ts");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  let api: ReturnType<typeof useCamera> | undefined;
  const Probe = () => {
    api = useCamera({ x: 1, y: 2, zoom: 0.5 });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  expect(api!.camera).toEqual({ x: 1, y: 2, zoom: 0.5 });
  expect(api!.cameraRef.current).toEqual({ x: 1, y: 2, zoom: 0.5 });
  expect(typeof api!.setCamera).toBe("function");
  expect(typeof api!.zoomAt).toBe("function");
  expect(typeof api!.panBy).toBe("function");
  expect(typeof api!.fit).toBe("function");
});
