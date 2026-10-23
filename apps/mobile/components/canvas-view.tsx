import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { View } from "react-native";
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
import type { DesignSession } from "../lib/design";
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

/** The screen's corner radius on current iPhones, which a focused board's trace follows. */
const SCREEN_RADIUS = 55;

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
 * `ready`, and again if iOS reloads the page, it gets everything at once.
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
    thread: string | null;
    page?: string;
    onMessage: (msg: FromCanvas) => void;
  }
>(function CanvasView(props, ref) {
  // The web view's instance methods; its typings declare a class the component isn't.
  const web = useRef<{ injectJavaScript(js: string): void; reload(): void }>(null);
  const ready = useRef(false);
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
      { t: "insets", insets: p.insets, sheet: p.sheet, radius: SCREEN_RADIUS },
      ...(doc ? [doc] : []),
      { t: "presence", presence: p.session.getState().presence },
      { t: "pending", pin: p.pending },
      { t: "thread", id: p.thread },
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
    () => send({ t: "insets", insets: props.insets, sheet: props.sheet, radius: SCREEN_RADIUS }),
    [props.insets.top, props.insets.bottom, props.sheet],
  );
  useEffect(() => send({ t: "pending", pin: props.pending }), [props.pending]);
  useEffect(() => send({ t: "thread", id: props.thread }), [props.thread]);

  const onMessage = (e: WebViewMessageEvent) => {
    const msg = parseFromCanvas(e.nativeEvent.data);
    if (!msg) return;
    if (msg.t === "ready") {
      ready.current = true;
      sendAll();
      for (const m of waiting.current.splice(0)) send(m);
    }
    if (msg.t === "error") console.warn("[canvas]", msg.message);
    props.onMessage(msg);
  };

  if (!canvasHtml) return <View style={{ flex: 1 }} testID="canvas-missing" />;
  const origin = `${props.base}/`;
  return (
    <WebView
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
        web.current?.reload();
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
