import { type CanvasHeadRow, DocCache } from "@ponzu/client";
import { CloudSource } from "@ponzu/client/canvas";
import { useSessionState } from "@ponzu/client/react";
import type { Actor, CanvasState } from "@ponzu/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { backend } from "../cloud/backend";
import { useLive } from "../cloud/canvases";
import { DOC_CACHE_PATH, fileStorage } from "../cloud/files";
import { phoneKeys } from "../cloud/persist";
import { useCloud } from "../cloud/query";
import { actorOf } from "./actor";
import { CanvasBridge } from "./bridge";

/*
 * A canvas on the phone (iPhone design §7): its replica on this side, the bridge to the page,
 * its live head row, and its view (`GET /v1/canvases/:id`, kept on disk for the preview and the
 * asset origin while the replica opens).
 */

/** The last canvases opened, on disk for offline (8 of them); signing out clears the folder. */
const docCache = new DocCache(fileStorage(...DOC_CACHE_PATH));

export { actorOf };

const CONNECTING: CanvasState = {
  status: "connecting",
  doc: null,
  path: "",
  presence: [],
  canUndo: false,
  canRedo: false,
};

export interface OpenCanvas {
  /** Null until the person and their `Live` are known. */
  source: CloudSource | null;
  bridge: CanvasBridge | null;
  state: CanvasState;
  /** The person, as their ops and comments name them. Null until signed in and open. */
  me: Actor | null;
}

/**
 * The canvas `canvasId` open for the signed-in person: one CloudSource and its bridge, closed
 * when the screen goes or the person changes. Its state, as it changes.
 */
export function useCanvasSource(canvasId: string): OpenCanvas {
  const { live, userId } = useCloud();
  const session = useSessionState(backend.session);
  const person = session.status === "signed_in" ? session.user : null;
  const [open, setOpen] = useState<{
    source: CloudSource;
    bridge: CanvasBridge;
    me: Actor;
  } | null>(null);
  useEffect(() => {
    if (!person || person.id !== userId) return;
    const me = actorOf(person);
    const source = new CloudSource({ api: backend.api, live, canvasId, me, cache: docCache });
    const bridge = new CanvasBridge(source, { canvasId, me });
    setOpen({ source, bridge, me });
    return () => {
      bridge.close();
      source.close();
      setOpen(null);
    };
  }, [canvasId, live, userId, person?.id]);
  // One subscription per replica, not one per render.
  const subscribe = useCallback(
    (changed: () => void) => open?.source.subscribe(changed) ?? (() => {}),
    [open],
  );
  const state = useSyncExternalStore(subscribe, () => open?.source.getState() ?? CONNECTING);
  return {
    source: open?.source ?? null,
    bridge: open?.bridge ?? null,
    state,
    me: open?.me ?? null,
  };
}

/** The canvas's head row, live: the agent, the pull request, needs you. */
export function useCanvasHead(canvasId: string): CanvasHeadRow | undefined {
  return useLive("canvas.head", { canvasId }).rows?.[0];
}

/** The canvas's view, painted first from disk: its name, preview, repo and asset origin. */
export function useCanvasView(canvasId: string) {
  const { userId } = useCloud();
  return useQuery({
    queryKey: phoneKeys.canvasView(canvasId),
    queryFn: () => backend.api.canvases.get(canvasId),
    enabled: userId !== null,
  });
}
