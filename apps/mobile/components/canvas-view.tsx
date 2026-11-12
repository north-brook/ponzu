import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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
import type { CanvasBridge } from "../lib/canvas/bridge";
import { allowLoad, assetsOrigin, pageHtml } from "../lib/canvas/page";
import { measured, PROBE_RATE } from "../lib/canvas-perf";
import { config } from "../lib/cloud/config";
import { displayRadius } from "../lib/screen";

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
 * The canvas: a web view that draws the canvas as the Mac does, loaded from the canvas's own
 * asset origin (`assetsUrl`), so every file the boards load is same-origin, under the page's
 * content security policy with that origin filled in (lib/canvas/page.ts). The replica is the
 * app's (CloudSource, on this side): `bridge` (lib/canvas/bridge.ts) tells the page each op, or
 * the whole doc when an op won't do. The page reports gestures back (`FromCanvas`). On `ready`,
 * and again if iOS ends the page's process, it gets everything at once.
 */
export const CanvasView = forwardRef<
  CanvasHandle,
  {
    /** The canvas's `assetsUrl`: the page's base URL and the origin its policy allows. */
    assetsUrl: string;
    bridge: CanvasBridge;
    theme: Theme;
    insets: Insets;
    /** How far a sheet over the canvas rises, px from the bottom. */
    sheet: number;
    pending: PendingPin | null;
    /** The Comment button was pressed: the next tap off a pin drops a comment's pin. */
    commenting?: boolean;
    /** New comments left unsent, by their draft's key: their pins stay, to tap. */
    unsent: (PendingPin & { key: string })[];
    /** Threads with a reply left unsent. */
    writing: string[];
    thread: string | null;
    /** The unsent comment whose pin is being moved, by its draft's key. */
    moving?: string | null;
    /** The page the person is on, or a link asked for: a page opening takes it. */
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
  /**
   * Bumped when iOS ends the page's process (it does, in the background, to
   * save memory): a new web view loads the page again. `reload()` can't, since
   * a page loaded from a string reloads its base URL.
   */
  const [generation, setGeneration] = useState(0);
  /** The web view on screen: a new asset origin or a new generation is a new one. */
  const viewKey = `${props.assetsUrl}#${generation}`;
  const shown = useRef(viewKey);
  shown.current = viewKey;
  /** The web view whose page has said `ready`: only it hears anything. */
  const readyKey = useRef<string | null>(null);
  const isReady = () => readyKey.current === shown.current;
  const latest = useRef(props);
  latest.current = props;

  const send = useCallback((msg: ToCanvas) => {
    if (isReady()) web.current?.injectJavaScript(toCanvasScript(msg));
  }, []);
  // What the screen asked for before the page could hear it.
  const waiting = useRef<ToCanvas[]>([]);
  const post = useCallback(
    (msg: ToCanvas) => {
      if (isReady()) send(msg);
      else waiting.current.push(msg);
    },
    [send],
  );
  useImperativeHandle(ref, () => ({ post }), [post]);

  /** Everything the canvas needs to draw from scratch. */
  const sendAll = useCallback(() => {
    const p = latest.current;
    const msgs: ToCanvas[] = [
      { t: "insets", insets: p.insets, sheet: p.sheet, radius: latestRadius.current },
      { t: "theme", theme: p.theme },
      // The doc, who's here and the agent's boards: the bridge's, from the replica.
      ...p.bridge.all(),
      { t: "pending", pin: p.pending },
      { t: "commenting", on: Boolean(p.commenting) },
      { t: "unsent", pins: p.unsent, threads: p.writing },
      { t: "thread", id: p.thread },
      { t: "move", key: p.moving ?? null },
      { t: "standby", on: Boolean(p.standby) },
      // How many gestures the page measures (lib/canvas-perf.ts); none unless asked.
      ...(PROBE_RATE ? [{ t: "probe", rate: PROBE_RATE } as const] : []),
    ];
    for (const m of msgs) send(m);
  }, [send]);

  // The replica, through the bridge: each op, or the whole doc when an op won't do.
  useEffect(
    () =>
      props.bridge.connect(send, {
        theme: () => latest.current.theme,
        page: () => latest.current.page,
      }),
    [props.bridge, send],
  );
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
  useEffect(
    () => send({ t: "commenting", on: Boolean(props.commenting) }),
    [Boolean(props.commenting)],
  );
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
      readyKey.current = shown.current;
      sendAll();
      for (const m of waiting.current.splice(0)) send(m);
    }
    if (msg.t === "error") console.warn("[canvas]", msg.message);
    if (msg.t === "perf") measured(msg.gesture);
    props.onMessage(msg);
  };

  const origin = assetsOrigin(props.assetsUrl);
  const html = useMemo(
    () => (canvasHtml && origin ? pageHtml(canvasHtml, origin) : null),
    [origin],
  );
  if (!html) return <View style={{ flex: 1 }} testID="canvas-missing" />;
  const base = props.assetsUrl;
  return (
    <WebView
      // A new asset origin (the canvas's key rotated) is a new page under a new policy.
      key={viewKey}
      ref={web as never}
      testID="canvas-web"
      source={{ html, baseUrl: base }}
      applicationNameForUserAgent={`Ponzu-iOS/${config().version}`}
      // Every navigation reaches the rule below. With a narrower list, react-native-webview
      // hands what it won't load to Linking.openURL: a link in a board would open Safari.
      originWhitelist={["*"]}
      // The page is the app's: it never navigates anywhere.
      onShouldStartLoadWithRequest={(r: { url: string }) => allowLoad(r.url, base)}
      onMessage={onMessage}
      onContentProcessDidTerminate={() => {
        readyKey.current = null;
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
