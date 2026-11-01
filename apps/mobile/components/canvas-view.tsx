import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
  type FromCanvas,
  type Insets,
  type PendingPin,
  parseFromCanvas,
  type Theme,
  type ToCanvas,
  toCanvasScript,
} from "../canvas/protocol";
import { measured, PROBE_RATE } from "../lib/canvas-perf";
import type { DesignSession } from "../lib/design";
import { displayRadius } from "../lib/screen";
import { VERSION } from "../lib/ua";

/**
 * The canvas page (`canvas/dist/bundle.ts`, built by `canvas/build.ts`).
 * Metro builds it as it starts (metro.config.js), and so does `bun run
 * typecheck`; a checkout that hasn't built it shows an empty canvas.
 */
function loadCanvasHtml(): string | null {
  try {
    return (require("../canvas/dist/bundle") as { canvasHtml: string }).canvasHtml;
  } catch {
    return null;
  }
}
const canvasHtml = loadCanvasHtml();

export interface CanvasHandle {
  /**
   * Tells the canvas something the screen asks for (a page, a focus). Before
   * the page is ready it waits, and goes once `ready` has sent everything.
   */
  post(msg: ToCanvas): void;
}

/**
 * The canvas: a web view that draws the design as desktop does. The app
 * holds the design's socket (`session`) and tells the page what to draw
 * (`ToCanvas`, canvas/protocol.ts): the doc on every hello, each op with who
 * made it, presence. The page reports gestures back (`FromCanvas`). On
 * `ready`, and again if iOS ends the page, it gets everything at once.
 */
export const CanvasView = forwardRef<
  CanvasHandle,
  {
    /** `http://<mac>:7777`: the page's origin, so its asset loads are the Mac's own. */
    base: string;
    session: DesignSession;
    theme: Theme;
    insets: Insets;
    /** How far a sheet over the canvas rises, px from the bottom. */
    sheet: number;
    pending: PendingPin | null;
    /** New comments left unsent, by their draft's key: their pins stay, to tap. */
    unsent: (PendingPin & { key: string })[];
    /** Threads with a reply left unsent. */
    writing: string[];
    thread: string | null;
    /** The unsent comment whose pin is being moved, by its draft's key. */
    moving?: string | null;
    page?: string;
    /** Standby: the page alone on black (iPhone Duo set down while an agent works). */
    standby?: boolean;
    onMessage: (msg: FromCanvas) => void;
  }
>(function CanvasView(props, ref) {
  // The display's corner (lib/screen.ts), which a focused board's ring follows.
  const { width, height } = useWindowDimensions();
  const radius = displayRadius(width, height);
  const latestRadius = useRef(radius);
  latestRadius.current = radius;
  // The web view's instance methods; its typings declare a class the component isn't.
  const web = useRef<{ injectJavaScript(js: string): void }>(null);
  const ready = useRef(false);
  /**
   * Bumped when iOS ends the page's process (it does, in the background, to
   * save memory): a new web view loads the page again. `reload()` can't, since
   * a page loaded from a string reloads its base URL, the Mac's `/`.
   */
  const [generation, setGeneration] = useState(0);
  const latest = useRef(props);
  latest.current = props;

  const send = useCallback((msg: ToCanvas) => {
    if (ready.current) web.current?.injectJavaScript(toCanvasScript(msg));
  }, []);
  // What the screen asked for before the page could hear it.
  const waiting = useRef<ToCanvas[]>([]);
  const post = useCallback(
    (msg: ToCanvas) => {
      if (ready.current) send(msg);
      else waiting.current.push(msg);
    },
    [send],
  );
  useImperativeHandle(ref, () => ({ post }), [post]);

  const docMessage = useCallback((): ToCanvas | null => {
    const p = latest.current;
    const doc = p.session.getState().doc;
    return doc
      ? {
          t: "doc",
          doc,
          assetBase: p.session.assetBase,
          theme: p.theme,
          file: p.session.file,
          ...(p.page ? { page: p.page } : {}),
        }
      : null;
  }, []);

  /** Everything the canvas needs to draw from scratch. */
  const sendAll = useCallback(() => {
    const p = latest.current;
    const doc = docMessage();
    const msgs: ToCanvas[] = [
      { t: "insets", insets: p.insets, sheet: p.sheet, radius: latestRadius.current },
      // Before the socket's first hello there's no doc to carry it.
      { t: "theme", theme: p.theme },
      ...(doc ? [doc] : []),
      { t: "presence", presence: p.session.getState().presence },
      { t: "pending", pin: p.pending },
      { t: "unsent", pins: p.unsent, threads: p.writing },
      { t: "thread", id: p.thread },
      { t: "move", key: p.moving ?? null },
      { t: "standby", on: Boolean(p.standby) },
      // How many gestures the page measures (lib/canvas-perf.ts); none unless asked.
      ...(PROBE_RATE ? [{ t: "probe", rate: PROBE_RATE } as const] : []),
    ];
    for (const m of msgs) send(m);
  }, [send, docMessage]);

  // The socket: a whole doc on each hello and reset, ops as they come, presence as it changes.
  useEffect(() => {
    const s = props.session;
    let presence = s.getState().presence;
    const offDoc = s.onDoc(() => {
      const doc = docMessage();
      if (doc) send(doc);
    });
    const offOp = s.onOp((op, origin) => send({ t: "op", op, origin }));
    const offState = s.subscribe(() => {
      const next = s.getState().presence;
      if (next !== presence) {
        presence = next;
        send({ t: "presence", presence: next });
      }
    });
    return () => {
      offDoc();
      offOp();
      offState();
    };
  }, [props.session]);
  useEffect(() => send({ t: "theme", theme: props.theme }), [props.theme]);
  useEffect(
    () => send({ t: "insets", insets: props.insets, sheet: props.sheet, radius }),
    [
      props.insets.top,
      props.insets.right,
      props.insets.bottom,
      props.insets.left,
      props.sheet,
      radius,
    ],
  );
  useEffect(() => send({ t: "pending", pin: props.pending }), [props.pending]);
  // By value: the list is made again on every change to the doc.
  const unsentKey = JSON.stringify([props.unsent, props.writing]);
  useEffect(() => send({ t: "unsent", pins: props.unsent, threads: props.writing }), [unsentKey]);
  useEffect(() => send({ t: "thread", id: props.thread }), [props.thread]);
  useEffect(() => send({ t: "move", key: props.moving ?? null }), [props.moving]);
  useEffect(() => send({ t: "standby", on: Boolean(props.standby) }), [props.standby]);

  const onMessage = (e: WebViewMessageEvent) => {
    const msg = parseFromCanvas(e.nativeEvent.data);
    if (!msg) return;
    if (msg.t === "ready") {
      ready.current = true;
      sendAll();
      for (const m of waiting.current.splice(0)) send(m);
    }
    if (msg.t === "error") console.warn("[canvas]", msg.message);
    if (msg.t === "perf") measured(msg.gesture);
    props.onMessage(msg);
  };

  if (!canvasHtml) return <View style={{ flex: 1 }} testID="canvas-missing" />;
  const origin = `${props.base}/`;
  return (
    <WebView
      key={generation}
      ref={web as never}
      testID="canvas-web"
      source={{ html: canvasHtml, baseUrl: origin }}
      applicationNameForUserAgent={`Ponzu-iOS/${VERSION}`}
      originWhitelist={["*"]}
      // The page is the app's; it never navigates anywhere.
      onShouldStartLoadWithRequest={(r: { url: string }) =>
        r.url === origin || r.url.startsWith("about:")
      }
      onMessage={onMessage}
      onContentProcessDidTerminate={() => {
        ready.current = false;
        setGeneration((g) => g + 1);
      }}
      scrollEnabled={false}
      bounces={false}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      allowsLinkPreview={false}
      textInteractionEnabled={false}
      style={{ flex: 1, backgroundColor: "transparent" }}
      containerStyle={{ backgroundColor: "transparent" }}
    />
  );
});
