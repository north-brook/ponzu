import { linkTarget } from "@ponzu/core";
import { type MenuAction, MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import { onlineManager } from "@tanstack/react-query";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FromCanvas } from "../../canvas/protocol";
import { CanvasPlaceholder } from "../../components/canvas-placeholder";
import { CanvasStack } from "../../components/canvas-stack";
import { type CanvasHandle, CanvasView } from "../../components/canvas-view";
import { BarButton } from "../../components/chrome";
import { Glass, GlassGroup } from "../../components/glass";
import { Back, PageIcon } from "../../components/icons";
import { Shimmer } from "../../components/shimmer";
import { canvasStatus, previewUrl } from "../../lib/canvas/status";
import { useCanvasHead, useCanvasSource, useCanvasView } from "../../lib/canvas/use-canvas";
import { backend } from "../../lib/cloud/backend";
import { select, tick } from "../../lib/haptics";
import { pageIconImage } from "../../lib/page-icons";
import { Juice } from "../../lib/slice";
import { useTheme } from "../../lib/theme";
import { EASE_OUT } from "../../lib/tokens";
import { useWindowInsets } from "../../lib/window-insets";

const ease = Easing.bezier(...EASE_OUT);
/** The canvas's bar: 6pt above and below its 44pt controls. */
const BAR = 56;
const NO_PINS: never[] = [];

/** Back where the canvas was opened from; opened by a link with nothing behind it, the list. */
function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/canvases");
}

/**
 * A canvas, live and read only (iPhone design §7): its boards drawn in the web view from the
 * replica on this side (CloudSource, lib/canvas/use-canvas.ts, through lib/canvas/bridge.ts),
 * with the app's chrome over it: Back, the canvas's name in the middle (shimmering while the
 * agent wakes or works), the page button with the pages' native menu, and the floating stack
 * (pull request, Comment, Chat). Double-tap a board to focus it, and the chrome steps aside;
 * pan and pinch as on the Mac. Comments, the chat and the pull request sheets come with their
 * own slices; until then their buttons are shown and unavailable.
 *
 * Opened from a row, a link or a push: `page` and `artboard` say where to open (a board on its
 * page, or a page, as @ponzu/core's `linkTarget` reads them).
 */
export default function CanvasScreen() {
  const params = useLocalSearchParams<{
    id: string;
    page?: string;
    artboard?: string;
    sheet?: string;
    question?: string;
    thread?: string;
    message?: string;
  }>();
  const canvasId = params.id;
  const { color, scheme } = useTheme();
  const safe = useSafeAreaInsets();
  // The window's, the rail at the side included.
  const windowInsets = useWindowInsets();
  const insets = { ...safe, left: windowInsets.left, right: windowInsets.right };
  const { source, bridge, state } = useCanvasSource(canvasId);
  const head = useCanvasHead(canvasId);
  const view = useCanvasView(canvasId);
  const doc = state.doc;
  const status = canvasStatus(head, state);
  const canvas = useRef<CanvasHandle>(null);

  // The page draws from the canvas's own files: known from the replica, or first from the view.
  const assetsUrl = source?.assetBase ?? view.data?.assetsUrl ?? null;
  const name = head?.name ?? view.data?.name ?? (state.path || doc?.name || "");

  // The agent's boards get the ring.
  const ringed = status.working.join(" ");
  useEffect(() => bridge?.setWorking(status.working), [bridge, ringed]);

  // Seen as of now, once the canvas is in.
  const seen = useRef(false);
  useEffect(() => {
    if (seen.current || state.status !== "ready" || !head) return;
    seen.current = true;
    backend.api.canvases.seen(canvasId, { seq: head.seq }).catch(() => {});
  }, [state.status, head?.seq]);

  // Back in front, or back online: try now rather than sit out a wait.
  useEffect(() => {
    if (!source) return;
    const app = AppState.addEventListener("change", (next) => {
      if (next === "active") source.retryNow();
    });
    const net = onlineManager.subscribe((online) => {
      if (online) source.retryNow();
    });
    return () => {
      app.remove();
      net();
    };
  }, [source]);

  // Where a link opens, once the doc names it: a board on its page, or a page.
  const opening = useMemo(
    () =>
      doc && (params.page || params.artboard)
        ? linkTarget(doc, { page: params.page, artboard: params.artboard })
        : null,
    [Boolean(doc), params.page, params.artboard],
  );
  const [pageId, setPageId] = useState<string | null>(null);
  const shownPage = pageId ?? opening?.pageId ?? undefined;
  const page = doc?.pages.find((p) => p.id === shownPage) ?? doc?.pages[0];
  useEffect(() => {
    source?.setPage(page?.id ?? null);
  }, [source, page?.id]);
  // The board a link names comes into focus once the canvas has drawn.
  const [drawn, setDrawn] = useState(false);
  const focusedOnce = useRef(false);
  useEffect(() => {
    const id = opening?.artboardId;
    if (!id || !drawn || focusedOnce.current) return;
    focusedOnce.current = true;
    canvas.current?.post({ t: "focus", artboardId: id });
  }, [drawn, opening?.artboardId]);

  /** The focused board has the screen: the chrome steps aside. */
  const [focusedBoard, setFocusedBoard] = useState<string | null>(null);
  /** A pan or pinch on the focused board: the chrome is back while it lasts. */
  const [moving, setMoving] = useState(false);
  const wasFocused = useRef<string | null>(null);
  const onMessage = useCallback((msg: FromCanvas) => {
    switch (msg.t) {
      case "page":
        setPageId(msg.pageId);
        break;
      case "focused":
        if (Boolean(msg.artboardId) !== Boolean(wasFocused.current)) tick();
        wasFocused.current = msg.artboardId;
        setFocusedBoard(msg.artboardId);
        setMoving(false);
        break;
      case "gesture":
        setMoving(true);
        break;
      case "drawn":
        setDrawn(true);
        break;
    }
  }, []);

  const bare = Boolean(focusedBoard) && !moving;
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ autoHideHomeIndicator: bare });
  }, [bare]);
  const chrome = useSharedValue(1);
  useEffect(() => {
    chrome.value = withTiming(bare ? 0 : 1, { duration: bare ? 220 : 160, easing: ease });
  }, [bare]);
  // The glass dissolves as the system's does (never faded, components/glass.tsx); what it holds
  // fades on this clock.
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chrome.value }));

  const pageActions = useMemo<MenuAction[]>(
    () =>
      (doc?.pages ?? []).map((p) => ({
        id: p.id,
        title: p.name,
        image: pageIconImage(p.icon),
        state: p.id === page?.id ? "on" : "off",
      })),
    [doc?.pages, page?.id],
  );
  const pickPage = ({ nativeEvent }: NativeActionEvent) => {
    const id = nativeEvent.event;
    select();
    if (id === page?.id) return;
    setPageId(id);
    canvas.current?.post({ t: "page", pageId: id });
  };
  const manyPages = (doc?.pages.length ?? 0) > 1;

  const canvasInsets = useMemo(
    () => ({ top: insets.top + BAR, right: 0, bottom: insets.bottom, left: 0 }),
    [insets.top, insets.bottom],
  );

  if (status.mood === "gone") return <Gone line={status.line!} />;

  const loading = !drawn;
  const titleIcon = loading ? (
    <View testID="canvas-loading">
      <Juice size={17} color={color.ink} />
    </View>
  ) : null;
  // The offline card over the placeholder says it while the canvas hasn't drawn; after, the
  // line under the title does.
  const placeholderLine = !drawn && status.mood === "offline" ? status.line : null;
  const line = placeholderLine ? null : status.line;
  return (
    <View testID="canvas" style={{ flex: 1, backgroundColor: color.canvas }}>
      {bridge && assetsUrl && (
        <CanvasView
          ref={canvas}
          assetsUrl={assetsUrl}
          bridge={bridge}
          theme={scheme}
          insets={canvasInsets}
          sheet={0}
          pending={null}
          unsent={NO_PINS}
          writing={NO_PINS}
          thread={null}
          page={shownPage}
          onMessage={onMessage}
        />
      )}
      {/* Until the canvas has drawn: the canvas as the phone already has it (its preview). */}
      <CanvasPlaceholder
        preview={previewUrl(view.data, scheme)}
        drawn={drawn}
        top={insets.top + BAR}
        bottom={insets.bottom}
        offline={placeholderLine}
      />
      <Animated.View
        pointerEvents={bare ? "none" : "box-none"}
        // Gone while bare: out of reach of touch and VoiceOver as well as sight.
        accessibilityElementsHidden={bare}
        importantForAccessibility={bare ? "no-hide-descendants" : "auto"}
        testID={bare ? "chrome-hidden" : "chrome"}
        style={{ position: "absolute", left: 0, right: 0, top: insets.top, zIndex: 8 }}
      >
        <GlassGroup
          style={{
            paddingVertical: 6,
            paddingHorizontal: 16,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}
        >
          <BarButton
            label="Back"
            testID="back"
            shown={!bare}
            onPress={() => {
              tick();
              leave();
            }}
          >
            <Animated.View style={chromeStyle}>
              <Back color={color.ink} />
            </Animated.View>
          </BarButton>
          <View style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel={status.line ? `${name}. ${status.line}` : name}
              testID="title"
              style={{ maxWidth: "100%" }}
            >
              <Glass shown={!bare} style={{ height: 44 }}>
                <Animated.View
                  style={[
                    {
                      height: 44,
                      paddingLeft: titleIcon ? 12 : 16,
                      paddingRight: 16,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 7,
                    },
                    chromeStyle,
                  ]}
                >
                  {titleIcon}
                  {status.busy ? (
                    <Shimmer text={name} style={titleText} color={color.ink} />
                  ) : (
                    <Text numberOfLines={1} style={[titleText, { color: color.ink }]}>
                      {name}
                    </Text>
                  )}
                </Animated.View>
              </Glass>
            </View>
          </View>
          {/* The page: its icon alone, and the pages' menu from it. */}
          {manyPages ? (
            <MenuView
              actions={pageActions}
              onPressAction={pickPage}
              onOpenMenu={select}
              themeVariant={scheme}
            >
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel={`Page: ${page?.name ?? ""}`}
                testID="page-menu"
              >
                <Glass
                  interactive
                  shown={!bare}
                  style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
                >
                  <Animated.View style={chromeStyle}>
                    <PageIcon name={page?.icon} size={20} color={color.ink} />
                  </Animated.View>
                </Glass>
              </View>
            </MenuView>
          ) : (
            <View style={{ width: 44 }} />
          )}
        </GlassGroup>
        {line && !bare && (
          <View style={{ alignItems: "center", marginTop: 2 }} pointerEvents="none">
            <Glass style={{ borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text
                testID="canvas-line"
                style={{
                  fontFamily: "Inter",
                  fontWeight: "500",
                  fontSize: 13,
                  lineHeight: 17,
                  color: color.muted,
                  textAlign: "center",
                }}
              >
                {line}
              </Text>
            </Glass>
          </View>
        )}
      </Animated.View>
      {!bare && (
        <CanvasStack
          bottom={Math.max(insets.bottom, 16) + 8}
          right={16 + insets.right}
          prNumber={head?.prNumber ?? null}
          chat={status.chat}
        />
      )}
    </View>
  );
}

/** Deleted, or no longer the person's to see: the line, and the way back. */
function Gone({ line }: { line: string }) {
  const { color } = useTheme();
  return (
    <View
      testID="canvas-gone"
      style={{
        flex: 1,
        backgroundColor: color.bg,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 40,
      }}
    >
      <Text
        style={{
          fontFamily: "Inter",
          fontSize: 15,
          lineHeight: 22,
          color: color.muted,
          textAlign: "center",
        }}
      >
        {line}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        testID="canvas-gone-back"
        hitSlop={10}
        onPress={() => {
          tick();
          leave();
        }}
      >
        <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 15, color: color.ink }}>
          Back
        </Text>
      </Pressable>
    </View>
  );
}

/** The canvas's name in the title capsule: Inter 600 16, cut short only when it doesn't fit. */
const titleText = {
  flexShrink: 1,
  fontFamily: "Inter",
  fontWeight: "600",
  fontSize: 16,
} as const;
