import { agentActivity, findArtboard, newId, type Presence, type Thread } from "@ponzu/core";
import { type MenuAction, MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import type { FromCanvas, PendingPin } from "../../../canvas/protocol";
import { CanvasPlaceholder } from "../../../components/canvas-placeholder";
import { type CanvasHandle, CanvasView } from "../../../components/canvas-view";
import { BarButton } from "../../../components/chrome";
import { Comments, openThreads } from "../../../components/comments";
import { Composer, initialMode, type Mode } from "../../../components/composer";
import {
  CommentsHalf,
  CommentsPanel,
  Fold,
  Glide,
  NativeBarItems,
  PagePill,
  useOpening,
} from "../../../components/duo-chrome";
import { Glass, GlassGroup } from "../../../components/glass";
import { AgentAvatar, AgentMark, Back, FileIcon, PageIcon } from "../../../components/icons";
import { Sheet } from "../../../components/sheet";
import { Shimmer } from "../../../components/shimmer";
import { ThreadSheet } from "../../../components/thread-sheet";
import { useMacChanges } from "../../../lib/activity-store";
import { useFile } from "../../../lib/catalog";
import { useDesignSession, useSessionState } from "../../../lib/design";
import { useDuoLayout } from "../../../lib/duo";
import { CREASE, foldAt } from "../../../lib/duo-layout";
import { select, success, tick } from "../../../lib/haptics";
import { noteOpened } from "../../../lib/lately";
import { baseUrl } from "../../../lib/mac";
import { findMac } from "../../../lib/macs";
import { pageIconImage } from "../../../lib/page-icons";
import { markSeen, seen } from "../../../lib/seen";
import { Juice } from "../../../lib/slice";
import { FOLLOW, standbyPath } from "../../../lib/standby";
import { track } from "../../../lib/telemetry";
import { useTheme } from "../../../lib/theme";
import { keepThreads } from "../../../lib/threads";
import { EASE_OUT } from "../../../lib/tokens";
import { StandbyAwake, StillSensor, useFollow, useStandby } from "../../../lib/use-standby";
import { useWindowInsets } from "../../../lib/window-insets";

const ease = Easing.bezier(...EASE_OUT);
/** The person, as their comments name them. */
const ME = { kind: "user" as const, name: "You" };

/**
 * The canvas (Flow › 3 Canvas): the design in a web view, drawn as desktop
 * draws it, and React Native's chrome over it: back, the file's title in the
 * middle and the page button with the pages' native menu. While an agent is
 * here its mark takes the file icon's place (the name shimmering while it
 * works), and the title opens its session card (4 Agent). Hold to comment (6–9), tap a pin for its
 * thread (11), double-tap a board to focus it (5): the chrome fades away
 * while a board is focused, and comes back as a pan or pinch begins.
 */
export default function Canvas() {
  const params = useLocalSearchParams<{
    mac: string;
    key: string;
    /** Open a thread's sheet, from Activity or a push. */
    thread?: string;
    /** Focus a frame, from search. */
    artboard?: string;
    /** Open on a page, by id or name (ponzu://design/<mac>/<key>?page=App). */
    page?: string;
    /** Development: open the comment sheet as if held at the middle of this artboard. */
    comment?: string;
    /** Development: delete the person's threads that start with this text, so a test leaves the file as it was. */
    uncomment?: string;
    /** Development: standby on, as if set down while an agent works (the simulator has no motion). */
    standby?: string;
  }>();
  const { color, scheme } = useTheme();
  const screenInsets = useSafeAreaInsets();
  // The window's, the rail included: a screen under a native header gets its own, without it.
  const windowInsets = useWindowInsets();
  const insets = { ...screenInsets, left: windowInsets.left, right: windowInsets.right };
  const mac = findMac(params.mac);
  const base = mac ? baseUrl(mac) : null;
  const session = useDesignSession(base, params.key);
  const state = useSessionState(session);
  const doc = state.doc;
  const file = useFile(params.mac, params.key);
  const canvas = useRef<CanvasHandle>(null);

  const [pageId, setPageId] = useState<string | null>(null);
  const [pending, setPending] = useState<(PendingPin & { nodeId?: string }) | null>(null);
  /** A sent comment's sheet on its way out: whose pin, and whether the send and the slide are done. */
  const leave = useRef<{ pin: PendingPin; sent: boolean; away: boolean } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(params.thread ?? null);
  // A link to a thread on the design already open (Activity, a push) opens it there.
  useEffect(() => {
    if (params.thread) setThreadId(params.thread);
  }, [params.thread]);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [sheet, setSheet] = useState(0);
  const [card, setCard] = useState(false);
  /** The focused board: the chrome steps aside for it. */
  const [focusedBoard, setFocusedBoard] = useState<string | null>(null);
  /** A pan or pinch is under way on the focused board: the chrome is back while it lasts. */
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The canvas has drawn its first page: the placeholder gives way. */
  const [drawn, setDrawn] = useState(false);
  /**
   * The comments surface is open (the sheet, or the panel open sideways). A
   * thread opened from it shows in it, with ← back to the list; folded, it's
   * always there.
   */
  const [commentsOpen, setCommentsOpen] = useState(false);
  const duo = useDuoLayout();
  const nativeBars = duo.bars !== "phone";
  /** Comments always there, past the fold. */
  const split = duo.split;
  // When the person last looked here, for the comments list's unread dots: as the canvas opened.
  const seenAt = useRef(file ? (seen.get()[`${file.mac}:${file.key}`] ?? 0) : 0).current;

  useEffect(() => {
    track("canvas opened");
  }, []);
  // Search's "Opened lately", with the page it's on.
  const pageNow = pageId ?? doc?.pages[0]?.id;
  useEffect(() => {
    if (doc) noteOpened({ mac: params.mac, key: params.key, page: pageNow, at: Date.now() });
  }, [Boolean(doc), pageNow]);
  // Seen as of now, and kept for Activity as the doc changes.
  useEffect(() => {
    if (file) markSeen(file.mac, file.key, file.modified);
  }, [file?.modified]);
  useEffect(() => {
    if (doc) keepThreads(params.mac, params.key, doc);
  }, [doc?.threads]);
  useEffect(() => {
    if (session) session.setTheme(scheme);
  }, [session, scheme, state.status]);
  // From search: focus the frame once the canvas has the doc.
  const focused = useRef(false);
  useEffect(() => {
    if (!doc || !params.artboard || focused.current) return;
    focused.current = true;
    setTimeout(() => canvas.current?.post({ t: "focus", artboardId: params.artboard! }), 400);
  }, [doc]);

  // A page asked for by the link, once the doc names it.
  const asked = params.page
    ? doc?.pages.find((p) => p.id === params.page || p.name === params.page)?.id
    : undefined;
  useEffect(() => {
    if (asked && !pageId) {
      setPageId(asked);
      canvas.current?.post({ t: "page", pageId: asked });
    }
  }, [asked]);
  const page = doc?.pages.find((p) => p.id === pageId) ?? doc?.pages[0];
  // Development: `?comment=<artboard name or id>` opens the sheet on that board, for screenshots.
  useEffect(() => {
    if (!__DEV__ || !doc || !params.comment) return;
    const found = doc.pages
      .flatMap((p) => p.artboards.map((a) => ({ p, a })))
      .find(({ a }) => a.id === params.comment || a.name === params.comment);
    if (!found) return;
    const t = setTimeout(() => {
      setPending({ pageId: found.p.id, artboardId: found.a.id, x: 118, y: 150 });
      canvas.current?.post({ t: "focus", artboardId: found.a.id });
    }, 900);
    return () => clearTimeout(t);
  }, [Boolean(doc)]);
  const [uncommented, setUncommented] = useState(false);
  useEffect(() => {
    if (!__DEV__ || !doc || !session || !params.uncomment || uncommented) return;
    const mine = doc.threads.filter(
      (t) =>
        t.messages[0]?.author.kind === "user" && t.messages[0].text.startsWith(params.uncomment!),
    );
    Promise.all(mine.map((t) => session.send({ op: "thread.delete", id: t.id })))
      .catch(() => {})
      .finally(() => setUncommented(true));
  }, [Boolean(doc)]);
  const agents = useMemo(
    () => state.presence.filter((p) => agentActivity(p, session?.file ?? params.key) !== null),
    [state.presence],
  );
  const agent = agents[0];
  /** The agent here is at work (its name shimmers in the title), not just watching for comments. */
  const working = agent ? agentActivity(agent, session?.file ?? params.key) === "working" : false;
  const thread = doc?.threads.find((t) => t.id === threadId) ?? null;

  // Standby (iPhone Duo set down while an agent works): the page alone on black, the camera
  // easing to each board the agent touches. Development's `?standby=1` forces it on the simulator.
  const fileKey = session?.file ?? params.key;
  const { standby, listen, setStill } = useStandby(
    state.presence,
    fileKey,
    __DEV__ && params.standby === "1",
  );
  const changes = useMacChanges(params.mac);
  const onPage = useMemo(() => new Set(page?.artboards.map((a) => a.id) ?? []), [page]);
  const path = useMemo(
    () => standbyPath({ presence: state.presence, changes, file: fileKey, page: onPage }),
    // Presence is a new array on every message; the path changes only with what's worked on.
    [JSON.stringify(state.presence.map((p) => p.working)), changes, fileKey, onPage],
  );
  const still = useReducedMotion();
  const following = useFollow(path, standby, FOLLOW);
  useEffect(() => {
    if (standby && following)
      canvas.current?.post({ t: "follow", artboardId: following, ms: still ? 0 : FOLLOW.move });
  }, [standby, following]);

  /** The board focused as the canvas last said: a haptic marks going into or out of focus, not a gesture settling. */
  const wasFocused = useRef<string | null>(null);
  const onMessage = useCallback((msg: FromCanvas) => {
    switch (msg.t) {
      case "longpress":
        // The comment's pin is dropped: the composer takes the sheet, so whatever was up (a
        // thread, the list of comments as a sheet or panel, the session card) gives way to it.
        // Folded, the comments are their own half, not this toggle, and stay.
        tick();
        setThreadId(null);
        setCard(false);
        setCommentsOpen(false);
        // A sent comment's sheet still on its way out comes back up for this one.
        leave.current = null;
        setLeaving(false);
        setPending({
          pageId: msg.pageId,
          artboardId: msg.artboardId,
          nodeId: msg.nodeId,
          x: msg.x,
          y: msg.y,
        });
        break;
      case "tap":
        // Writing, a tap on the design puts the keyboard down; the sheet rides it.
        KeyboardController.dismiss().catch(() => {});
        break;
      case "openThread":
        setPending(null);
        setThreadId(msg.id);
        break;
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

  const left = () => {
    const pin = leave.current?.pin;
    leave.current = null;
    setLeaving(false);
    // A pin dropped since stays.
    setPending((p) => (p === pin ? null : p));
    setSheet(0);
  };
  const createComment = async (text: string, m: Mode) => {
    if (!session || !pending) return;
    const now = Date.now();
    const thread: Thread = {
      id: newId("th"),
      ...(pending.artboardId ? { artboardId: pending.artboardId } : { pageId: pending.pageId }),
      ...(pending.nodeId ? { nodeId: pending.nodeId } : {}),
      x: pending.x,
      y: pending.y,
      status: "open",
      createdAt: now,
      updatedAt: now,
      messages: [{ id: newId("m"), author: ME, text, createdAt: now }],
    };
    // The sheet leaves with the keyboard as soon as it's sent, not once the Mac answers; it's
    // gone for good when both are done, and comes back up with the words if the Mac refuses.
    const pin = pending;
    leave.current = { pin, sent: false, away: false };
    setError(null);
    setLeaving(true);
    try {
      await session.send({ op: "thread.create", thread });
      track("comment left", { reply: false, mode: m });
      if (leave.current?.pin === pin) {
        leave.current.sent = true;
        if (leave.current.away) left();
      }
    } catch (err) {
      // A pin dropped since has its own sheet: this one's error isn't its to show.
      if (leave.current?.pin === pin) {
        leave.current = null;
        setLeaving(false);
        setError(String((err as Error).message ?? err));
      }
      throw err;
    }
  };
  const reply = async (text: string, m: Mode) => {
    if (!session || !thread) return;
    await session.send({
      op: "thread.message",
      id: thread.id,
      message: { id: newId("m"), author: ME, text, createdAt: Date.now() },
    });
    track("comment left", { reply: true, mode: m });
  };
  const setStatus = async (status: Thread["status"]) => {
    if (!session || !thread) return;
    await session.send({ op: "thread.update", id: thread.id, status });
    if (status === "resolved") {
      success();
      setThreadId(null);
      // Resolved from the comments surface, it goes back to the list; from its own sheet, it closes.
      if (!commentsOpen && !split) setSheet(0);
    }
  };

  /**
   * The title pill's page menu: the system's menu, dropping from the pill
   * as augmenter's do (@react-native-menu/menu), each page with its icon
   * from the asset catalog (`hi-*`, scripts/tab-icons.ts) and the open one
   * checked.
   */
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

  // Where the canvas is and what covers it. On a phone the chrome covers the status bar and the
  // top bar (54 + 56), and the home indicator. On iPhone Duo the system's bars are a rail at the
  // side (closed, and open sideways) or horizontal (open upright): the canvas keeps clear of the
  // rail, and its pills sit 16pt down on the canvas. Folded, the design keeps one half and the
  // comments the other, 12pt either side of the fold kept clear.
  const W = duo.width;
  const H = duo.height;
  const fold = split ? foldAt({ width: W, height: H }, split) : 0;
  const area =
    split === "beside"
      ? { left: 0, top: 0, width: fold - CREASE, height: H }
      : split === "below"
        ? { left: 0, top: 0, width: W, height: fold - CREASE }
        : { left: 0, top: 0, width: W - insets.right, height: H };
  // Upright the system's bar is the top row, Back at its left: the file pill sits in that row,
  // centered, as the board's top bar (the safe area's top is the bar's foot, 56pt below its top).
  const pillTop =
    duo.bars === "upright" ? Math.max(8, insets.top - 56) : nativeBars ? 16 : insets.top + 6;
  const top = duo.bars === "upright" ? insets.top + 6 : pillTop + 50;
  /** The comments panel shows, open sideways: the canvas frames its boards left of it. */
  const panelShown = duo.panel && Boolean(commentsOpen || thread);
  const canvasInsets = useMemo(
    () =>
      standby
        ? { top: 0, right: 0, bottom: 0, left: 0 }
        : {
            top,
            right: W - area.width + (panelShown ? 344 + 20 : 0),
            bottom:
              split === "below"
                ? H - area.height
                : nativeBars && duo.bars === "upright"
                  ? insets.bottom + 56
                  : insets.bottom,
            left: 0,
          },
    [
      standby,
      top,
      W,
      H,
      area.width,
      area.height,
      split,
      nativeBars,
      duo.bars,
      insets.bottom,
      panelShown,
    ],
  );
  // Loading, the file icon's slot holds the slice juicing; an agent's mark once one's here.
  const titleIcon = !drawn ? (
    <View testID="canvas-loading">
      <Juice size={17} color={color.ink} />
    </View>
  ) : agent ? (
    <AgentMark client={agent.client} size={18} color={color.ink} />
  ) : (
    <FileIcon size={17} color={color.ink} />
  );
  /** The pages' native menu around a control (the page pill open sideways). */
  const pageMenu = (pill: React.ReactNode) =>
    manyPages ? (
      <MenuView
        actions={pageActions}
        onPressAction={pickPage}
        onOpenMenu={select}
        themeVariant={scheme}
      >
        <View testID="page-menu">{pill}</View>
      </MenuView>
    ) : (
      pill
    );
  /** A new comment's unsent words are kept under its pin's place. */
  const pinDraft = pending
    ? `pin:${pending.artboardId ?? pending.pageId}:${pending.x}:${pending.y}`
    : undefined;
  /** The page's open threads: the count on the comments button. */
  const open = openThreads(doc, page?.id);

  // Focused, the board has the screen: no bar, and the home indicator fades as the system's
  // full-screen views do. Writing or reading a comment, or the agent's card, keeps the bar.
  const bare = Boolean(focusedBoard) && !moving && !pending && !thread && !card;
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ autoHideHomeIndicator: bare });
  }, [bare]);
  const chrome = useSharedValue(1);
  useEffect(() => {
    chrome.value = withTiming(bare ? 0 : 1, { duration: bare ? 220 : 160, easing: ease });
  }, [bare]);
  // The bar's glass dissolves as the system's does (never faded, components/glass.tsx); what it
  // holds fades on this clock.
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chrome.value }));
  // The gesture hint, once each time a design opens: never again after a focus.
  const [hinted, setHinted] = useState(false);
  const hint = Boolean(doc) && !hinted;

  const close = () => {
    setCommentsOpen(false);
    setThreadId(null);
    setSheet(0);
  };
  /** The comments surface's content, with × where it can close. */
  const comments = (onClose: (() => void) | undefined) => (
    <Comments
      doc={doc}
      pageId={page?.id}
      thread={thread}
      onOpen={(id) => {
        setPending(null);
        setThreadId(id);
      }}
      onBack={() => setThreadId(null)}
      onClose={onClose}
      seen={seenAt}
      me="Y"
      onReply={reply}
      onStatus={setStatus}
    />
  );

  if (!mac || !base) return <Missing message="This Mac isn't paired anymore." />;
  return (
    <View
      testID={standby ? "standby" : "canvas"}
      style={{ flex: 1, backgroundColor: standby ? "#0b0b0a" : color.canvas }}
    >
      {listen && <StillSensor onStill={setStill} />}
      {standby && <StandbyAwake />}
      {/*
        Standby is the page alone, the full width of the display: the status bar's vertical rail
        is turned horizontal for it, then hidden (Apple's "full width for immersive interfaces
        that don't scroll"), and the home indicator fades.
      */}
      {standby && (
        <>
          <Stack.Screen options={{ headerShown: false, autoHideHomeIndicator: true }} />
          <StatusBar hidden verticalBarBehaviorIOS="disabled" />
        </>
      )}
      {session && (
        <CanvasView
          ref={canvas}
          base={base}
          session={session}
          theme={scheme}
          insets={canvasInsets}
          sheet={sheet}
          pending={pending}
          thread={threadId}
          onMessage={onMessage}
          page={asked}
          standby={standby}
        />
      )}
      {/* Until the canvas has drawn: the design as the phone already has it (its preview). */}
      {!standby && (
        <CanvasPlaceholder
          file={file ?? null}
          drawn={drawn}
          top={insets.top + 56}
          bottom={insets.bottom}
          offline={
            !doc && state.status === "offline" ? `${mac.name} isn't answering. Trying again…` : null
          }
        />
      )}
      {card && (
        <Pressable
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 7,
            backgroundColor: scheme === "dark" ? "rgba(0,0,0,0.35)" : "rgba(17,17,16,0.12)",
          }}
          onPress={() => setCard(false)}
          accessibilityLabel="Close"
        />
      )}
      {nativeBars && !standby && (
        <>
          <Stack.Screen
            options={{
              headerShown: true,
              headerTransparent: true,
              headerTitle: "",
              headerBackVisible: false,
              headerShadowVisible: false,
            }}
          />
          <NativeBarItems
            page={page}
            pages={pageActions}
            onPage={(id) => pickPage({ nativeEvent: { event: id } } as NativeActionEvent)}
            count={open.length}
            onComments={() => {
              setThreadId(null);
              setCommentsOpen((o) => !o);
            }}
            onBack={() => router.back()}
            pageOnBar={duo.bars === "upright" || (!duo.panel && !split)}
            commentsShown={Boolean(split)}
          />
        </>
      )}
      {standby ? null : nativeBars ? (
        <DuoPills
          file={file?.name ?? doc?.name ?? ""}
          icon={titleIcon}
          working={working}
          agentName={agent?.name}
          card={card}
          onCard={agent ? () => setCard((c) => !c) : undefined}
          page={page}
          pageMenu={duo.panel || split === "beside" ? pageMenu : null}
          // With the panel open the page pill keeps to the canvas left of it (the board's 6).
          area={panelShown ? { ...area, width: area.width - 344 - 10 - 10 } : area}
          top={pillTop}
          bare={bare}
          chromeStyle={chromeStyle}
          split={Boolean(split)}
        />
      ) : (
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
              shown={!bare}
              onPress={() => {
                tick();
                router.back();
              }}
            >
              <Animated.View style={chromeStyle}>
                <Back color={color.ink} />
              </Animated.View>
            </BarButton>
            {/* The file, in the middle: an agent's mark in place of its icon while one is here, and its session card on a tap. */}
            <View style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
              <Pressable
                onPress={
                  agent
                    ? () => {
                        if (!card) tick();
                        setCard((c) => !c);
                      }
                    : undefined
                }
                disabled={!agent}
                accessibilityRole={agent ? "button" : "text"}
                accessibilityLabel={
                  agent
                    ? `${file?.name ?? doc?.name ?? ""}, ${agent.name}'s session`
                    : (file?.name ?? doc?.name ?? "")
                }
                testID="title"
                style={{ maxWidth: "100%" }}
              >
                <Glass
                  interactive={Boolean(agent)}
                  held={card}
                  shown={!bare}
                  style={{ height: 44 }}
                >
                  <Animated.View
                    style={[
                      {
                        height: 44,
                        paddingLeft: 12,
                        paddingRight: 14,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 7,
                      },
                      chromeStyle,
                    ]}
                  >
                    {titleIcon}
                    {working ? (
                      <Shimmer
                        text={doc?.name ?? file?.name ?? ""}
                        style={titleText}
                        color={color.ink}
                        surface={color.bar}
                      />
                    ) : (
                      <Text numberOfLines={1} style={[titleText, { color: color.ink }]}>
                        {doc?.name ?? file?.name ?? ""}
                      </Text>
                    )}
                  </Animated.View>
                </Glass>
              </Pressable>
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
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
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
        </Animated.View>
      )}
      {card && agent && doc && (
        <SessionCard presence={agent} top={insets.top + 58} doc={doc} file={params.key} />
      )}
      {hint && !standby && (
        <Hint bottom={insets.bottom} away={Boolean(focusedBoard)} onDone={() => setHinted(true)} />
      )}
      {uncommented && (
        <View testID="uncommented" style={{ position: "absolute", width: 1, height: 1 }} />
      )}
      {pending && (
        <Sheet
          testID="comment-sheet"
          right={insets.right}
          onDismiss={() => {
            setPending(null);
            setSheet(0);
          }}
          onHeight={setSheet}
          away={leaving}
          onAway={() => {
            if (!leave.current) return;
            leave.current.away = true;
            if (leave.current.sent) left();
          }}
        >
          <Composer
            mode={mode}
            onMode={setMode}
            placeholder="Comment"
            onSend={createComment}
            leaves
            // One composer per pin: a pin dropped while the last comment is still sending gets
            // its own, which that send's ack can't empty.
            key={pinDraft}
            draft={pinDraft}
          />
          {error && (
            <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.muted }}>{error}</Text>
          )}
        </Sheet>
      )}
      {/*
        Comments, one surface in every pose: the list of this page's open threads, or a thread
        opened from it or its pin. Folded it's half the display, always there; open sideways
        an inset panel; on a phone, closed and upright the system's sheet. A pin tapped with no
        list open is the thread's own sheet, as on an iPhone.
      */}
      {standby ? null : split ? (
        <CommentsHalf
          style={
            split === "beside"
              ? { left: fold + CREASE, top: 0, width: W - insets.right - fold - CREASE, height: H }
              : { left: 0, top: fold + CREASE, width: W, height: H - fold - CREASE }
          }
        >
          {comments(undefined)}
        </CommentsHalf>
      ) : duo.panel && (commentsOpen || thread) ? (
        <CommentsPanel right={insets.right}>{comments(close)}</CommentsPanel>
      ) : commentsOpen ? (
        <Sheet
          testID="comments-sheet"
          right={insets.right}
          onDismiss={close}
          onHeight={setSheet}
          height={Math.min(450, H * 0.62)}
          gap={14}
        >
          {comments(close)}
        </Sheet>
      ) : (
        thread && (
          <ThreadSheet
            key={thread.id}
            right={insets.right}
            thread={thread}
            me="Y"
            onReply={reply}
            onStatus={setStatus}
            onDismiss={() => {
              setThreadId(null);
              setSheet(0);
            }}
            onHeight={setSheet}
          />
        )
      )}
      {split && !standby && <Fold axis={split === "below" ? "across" : "down"} at={fold} />}
    </View>
  );
}

function Missing({ message }: { message: string }) {
  const { color } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: color.bg,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
      }}
    >
      <Text style={{ fontFamily: "Inter", fontSize: 15, color: color.muted }}>{message}</Text>
      <Pressable onPress={() => router.back()}>
        <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 15, color: color.ink }}>
          Back
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * "Hold to comment · Double-tap a screen to focus", once each time a design
 * opens: it rises in over 0.4s, holds, and sinks out by 3.6s. A focus before
 * then sends it away at once. Either way it doesn't come back until the
 * design is opened again. The glass is never faded (components/glass.tsx):
 * it appears and dissolves as the system's glass does, and only the words
 * fade, while the whole rises and sinks.
 */
function Hint({ bottom, away, onDone }: { bottom: number; away: boolean; onDone: () => void }) {
  const { color } = useTheme();
  const t = useSharedValue(0);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const on = setTimeout(() => setShown(true), 400);
    const off = setTimeout(() => setShown(false), 400 + 400 + 2_100);
    t.value = withDelay(
      400,
      withSequence(
        withTiming(1, { duration: 400, easing: ease }),
        withDelay(
          2_100,
          withTiming(0, { duration: 400, easing: ease }, (done) => {
            if (done) scheduleOnRN(onDone);
          }),
        ),
      ),
    );
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, []);
  useEffect(() => {
    if (!away) return;
    setShown(false);
    t.value = withTiming(0, { duration: 160, easing: ease }, (done) => {
      if (done) scheduleOnRN(onDone);
    });
  }, [away]);
  const move = useAnimatedStyle(() => ({
    transform: [{ translateY: 12 * (1 - t.value) }, { scale: 0.96 + 0.04 * t.value }],
  }));
  const words = useAnimatedStyle(() => ({ opacity: t.value }));
  return (
    <Animated.View
      pointerEvents="none"
      testID="hint"
      style={[
        { position: "absolute", bottom: Math.max(34, bottom), alignSelf: "center", zIndex: 8 },
        move,
      ]}
    >
      <Glass
        shown={shown}
        style={{ height: 32, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" }}
      >
        <Animated.Text
          style={[
            { fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.ink },
            words,
          ]}
        >
          Hold to comment · Double-tap a screen to focus
        </Animated.Text>
      </Glass>
    </Animated.View>
  );
}

/** The file's name in the title capsule: Inter 600 16, cut short only when it really doesn't fit. */
const titleText = {
  flexShrink: 1,
  fontFamily: "Inter",
  fontWeight: "600",
  fontSize: 16,
} as const;

/** "Claude Code 2.1.0", from the MCP client's own name, as desktop's session card says it. */
function productName(p: Presence): string {
  const raw = p.origin?.clientName;
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    "claude-ai": "Claude",
    codex: "Codex",
    "codex-mcp-client": "Codex",
    cursor: "Cursor",
    "cursor-vscode": "Cursor",
  };
  const name = raw ? (known[raw] ?? raw) : p.name;
  return p.origin?.clientVersion ? `${name} ${p.origin.clientVersion}` : name;
}

function since(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** The agent's session card (Flow › 4 Agent), as desktop's. */
function SessionCard({
  presence: p,
  top,
  doc,
  file,
}: {
  presence: Presence;
  top: number;
  doc: NonNullable<ReturnType<typeof useSessionState>["doc"]>;
  file: string;
}) {
  const { color } = useTheme();
  const activity = agentActivity(p, file);
  const boards = p.working.map((id) => findArtboard(doc, id)?.artboard.name).filter(Boolean);
  const facts: [string, React.ReactNode][] = [];
  const mono = { fontFamily: "IBM Plex Mono", fontSize: 12, lineHeight: 16.8, color: color.ink };
  const body = { fontFamily: "Inter", fontSize: 14, lineHeight: 19.6, color: color.ink };
  if (p.origin?.cwd)
    facts.push([
      "Project",
      <Text key="cwd" numberOfLines={1} style={mono}>
        {p.origin.cwd.replace(/^\/Users\/[^/]+/, "~")}
      </Text>,
    ]);
  facts.push([
    "Via",
    p.origin?.via === "bridge" ? (
      <Text key="via" style={body}>
        Terminal · <Text style={mono}>ponzu mcp</Text>
      </Text>
    ) : (
      <Text key="via" style={body}>
        MCP over HTTP
      </Text>
    ),
  ]);
  facts.push([
    "Since",
    <Text key="since" style={body}>
      {since(p.since)}
    </Text>,
  ]);
  if (boards.length)
    facts.push([
      "On",
      <Text key="on" style={body} numberOfLines={2}>
        {boards.join(", ")}
      </Text>,
    ]);
  return (
    <Animated.View
      // Dropping from the title: it grows from under it, its glass never faded (components/glass.tsx).
      entering={ZoomIn.duration(220).easing(ease)}
      exiting={ZoomOut.duration(140)}
      testID="session-card"
      style={{
        position: "absolute",
        alignSelf: "center",
        top,
        width: 318,
        zIndex: 12,
        transformOrigin: "top center",
      }}
    >
      <Glass style={{ borderRadius: 24, padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <AgentAvatar
            name={p.name}
            client={p.client}
            size={28}
            color={color.ink}
            soft={color.pinSoft}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              style={{
                fontFamily: "Inter",
                fontWeight: "600",
                fontSize: 16,
                lineHeight: 20.8,
                color: color.ink,
              }}
            >
              {productName(p)}
            </Text>
            <Text
              numberOfLines={1}
              style={{ fontFamily: "Inter", fontSize: 14, lineHeight: 18.2, color: color.muted }}
            >
              {activity === "working" ? (p.status ?? "Working") : "Watching for comments"}
            </Text>
          </View>
        </View>
        <View style={{ paddingTop: 12, borderTopWidth: 1, borderTopColor: color.hairline, gap: 8 }}>
          {facts.map(([label, value]) => (
            <View key={label} style={{ flexDirection: "row", gap: 10 }}>
              <Text
                style={{
                  width: 62,
                  fontFamily: "Inter",
                  fontSize: 14,
                  lineHeight: 19.6,
                  color: color.muted,
                }}
              >
                {label}
              </Text>
              <View style={{ flex: 1, minWidth: 0 }}>{value}</View>
            </View>
          ))}
        </View>
      </Glass>
    </Animated.View>
  );
}

/**
 * The file and page pills on iPhone Duo, where the system's bars hold Back
 * (and the page, closed and upright). The file pill is centered on the
 * canvas closed and upright, and top left open sideways and in the book
 * pose, with the page pill top right (the board's 5). Each glides between
 * its places as the phone opens and closes (`Glide`), and they morph as
 * glass does, together in one GlassGroup.
 */
function DuoPills({
  file,
  icon,
  working,
  agentName,
  card,
  onCard,
  page,
  pageMenu,
  area,
  top,
  bare,
  chromeStyle,
  split,
}: {
  file: string;
  icon: React.ReactNode;
  working: boolean;
  agentName?: string;
  card: boolean;
  onCard?: () => void;
  page: { name: string; icon?: string } | undefined;
  /** The page pill and its menu, open sideways; null where the page is a bar item. */
  pageMenu: ((pill: React.ReactNode) => React.ReactNode) | null;
  /** The canvas's part of the window. */
  area: { left: number; top: number; width: number; height: number };
  top: number;
  bare: boolean;
  chromeStyle: ReturnType<typeof useAnimatedStyle>;
  /** Folded: the pills are at the book's corners, not opening. */
  split: boolean;
}) {
  const { color } = useTheme();
  // Measured widths, so a centered pill's left edge can glide like the rest.
  const [fileW, setFileW] = useState(120);
  const [pageW, setPageW] = useState(112);
  const corners = Boolean(pageMenu);
  const fileX = corners ? area.left + 20 : area.left + (area.width - fileW) / 2;
  const pageX = area.left + area.width - 16 - pageW;
  // Where the file pill was before it went to the corner (closed: centered beside the rail), and
  // the page's place on the rail, which the page pill comes from as the phone opens.
  const centered = useRef(fileX);
  if (!corners) centered.current = fileX;
  const opening = useOpening(corners && !split);
  return (
    <GlassGroup style={{ position: "absolute", inset: 0, zIndex: 8 }} spacing={10}>
      <View pointerEvents={bare ? "none" : "box-none"} style={{ flex: 1 }}>
        <Glide
          x={fileX}
          y={top}
          from={{ x: centered.current, y: top }}
          opening={opening}
          testID="title"
        >
          <Pressable
            onPress={
              onCard
                ? () => {
                    if (!card) tick();
                    onCard();
                  }
                : undefined
            }
            disabled={!onCard}
            accessibilityRole={onCard ? "button" : "text"}
            accessibilityLabel={agentName ? `${file}, ${agentName}'s session` : file}
            onLayout={(e) => setFileW(e.nativeEvent.layout.width)}
          >
            <Glass interactive={Boolean(onCard)} held={card} shown={!bare} style={{ height: 44 }}>
              <Animated.View
                style={[
                  {
                    height: 44,
                    paddingLeft: 13,
                    paddingRight: 16,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 7,
                  },
                  chromeStyle,
                ]}
              >
                {icon}
                {working ? (
                  <Shimmer text={file} style={titleText} color={color.ink} surface={color.bar} />
                ) : (
                  <Text numberOfLines={1} style={[titleText, { color: color.ink }]}>
                    {file}
                  </Text>
                )}
              </Animated.View>
            </Glass>
          </Pressable>
        </Glide>
        {pageMenu && (
          <Glide
            x={pageX}
            y={top}
            from={{ x: area.left + area.width, y: top + 104 }}
            opening={opening}
            testID="page-pill"
          >
            <View onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
              <PagePill page={page} menu={pageMenu} shown={!bare} />
            </View>
          </Glide>
        )}
      </View>
    </GlassGroup>
  );
}
