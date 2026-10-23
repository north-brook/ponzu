import { agentActivity, findArtboard, newId, type Presence, type Thread } from "@ponzu/core";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FromCanvas, PendingPin } from "../../../canvas/protocol";
import { type CanvasHandle, CanvasView } from "../../../components/canvas-view";
import { BarButton } from "../../../components/chrome";
import { Composer, initialMode, type Mode } from "../../../components/composer";
import { Glass, GlassGroup } from "../../../components/glass";
import { AgentMark, Back, Check, Chevron, FileIcon, PageIcon } from "../../../components/icons";
import { Sheet } from "../../../components/sheet";
import { ThreadSheet } from "../../../components/thread-sheet";
import { useFile } from "../../../lib/catalog";
import { useDesignSession, useSessionState } from "../../../lib/design";
import { baseUrl } from "../../../lib/mac";
import { findMac } from "../../../lib/macs";
import { markSeen } from "../../../lib/seen";
import { track } from "../../../lib/telemetry";
import { useTheme } from "../../../lib/theme";
import { keepThreads } from "../../../lib/threads";
import { EASE_OUT } from "../../../lib/tokens";

const ease = Easing.bezier(...EASE_OUT);
/** The person, as their comments name them. */
const ME = { kind: "user" as const, name: "You" };

/**
 * The canvas (Flow › 3 Canvas): the design in a web view, drawn as desktop
 * draws it, and React Native's chrome over it: back, the title pill (file and
 * page, with the page menu) and the agent's mark when one is here, which
 * opens its session card (4 Agent). Hold to comment (6–9), tap a pin for its
 * thread (11), double-tap a board to focus it (5).
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
  }>();
  const { color, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const mac = findMac(params.mac);
  const base = mac ? baseUrl(mac) : null;
  const session = useDesignSession(base, params.key);
  const state = useSessionState(session);
  const doc = state.doc;
  const file = useFile(params.mac, params.key);
  const canvas = useRef<CanvasHandle>(null);

  const [pageId, setPageId] = useState<string | null>(null);
  const [pending, setPending] = useState<(PendingPin & { nodeId?: string }) | null>(null);
  const [threadId, setThreadId] = useState<string | null>(params.thread ?? null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [sheet, setSheet] = useState(0);
  const [card, setCard] = useState(false);
  const [pages, setPages] = useState(false);
  /** The focused board, for the "where you are" pill. */
  const [focusedBoard, setFocusedBoard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    track("canvas opened");
  }, []);
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
  const agents = useMemo(
    () => state.presence.filter((p) => agentActivity(p, session?.file ?? params.key) !== null),
    [state.presence],
  );
  const agent = agents[0];
  const thread = doc?.threads.find((t) => t.id === threadId) ?? null;

  const onMessage = useCallback((msg: FromCanvas) => {
    switch (msg.t) {
      case "longpress":
        setThreadId(null);
        setCard(false);
        setPending({
          pageId: msg.pageId,
          artboardId: msg.artboardId,
          nodeId: msg.nodeId,
          x: msg.x,
          y: msg.y,
        });
        break;
      case "openThread":
        setPending(null);
        setThreadId(msg.id);
        break;
      case "page":
        setPageId(msg.pageId);
        break;
      case "focused":
        setFocusedBoard(msg.artboardId);
        break;
    }
  }, []);

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
    try {
      await session.send({ op: "thread.create", thread });
      track("comment left", { reply: false, mode: m });
      setPending(null);
      setSheet(0);
    } catch (err) {
      setError(String((err as Error).message ?? err));
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
      setThreadId(null);
      setSheet(0);
    }
  };

  // The chrome covers the status bar and the top bar (54 + 56), and the home indicator.
  const top = insets.top + 56;
  const canvasInsets = useMemo(
    () => ({ top, right: 0, bottom: insets.bottom, left: 0 }),
    [top, insets.bottom],
  );

  if (!mac || !base) return <Missing message="This Mac isn't paired anymore." />;
  return (
    <View testID="canvas" style={{ flex: 1, backgroundColor: color.canvas }}>
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
        />
      )}
      {!doc && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            inset: 0,
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          {state.status === "offline" ? (
            <Text style={{ fontFamily: "Inter", fontSize: 15, color: color.muted }}>
              {mac.name} isn't answering. Trying again…
            </Text>
          ) : (
            <ActivityIndicator color={color.faint} />
          )}
        </View>
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
      <GlassGroup
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: insets.top,
          paddingVertical: 6,
          paddingHorizontal: 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          zIndex: 8,
        }}
      >
        <BarButton label="Back" onPress={() => router.back()}>
          <Back color={color.ink} />
        </BarButton>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Pressable
            onPress={() => doc && doc.pages.length > 1 && setPages(true)}
            accessibilityRole="button"
            accessibilityLabel={`${file?.name ?? doc?.name ?? ""}, page ${page?.name ?? ""}`}
            testID="title"
          >
            <Glass
              interactive
              style={{
                height: 44,
                paddingHorizontal: 14,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                maxWidth: 236,
              }}
            >
              <FileIcon size={16} color={color.ink} />
              <Text
                numberOfLines={1}
                style={{
                  flexShrink: 1,
                  fontFamily: "Inter",
                  fontWeight: "600",
                  fontSize: 15,
                  color: color.ink,
                }}
              >
                {doc?.name ?? file?.name ?? ""}
              </Text>
              {page && (
                <>
                  <View
                    style={{
                      width: 1,
                      height: 14,
                      backgroundColor: color.hairline,
                      marginHorizontal: 2,
                    }}
                  />
                  <PageIcon name={page.icon} size={16} color={color.muted} />
                  <Text
                    numberOfLines={1}
                    style={{
                      flexShrink: 1,
                      fontFamily: "Inter",
                      fontWeight: "500",
                      fontSize: 15,
                      color: color.muted,
                    }}
                  >
                    {page.name}
                  </Text>
                  {(doc?.pages.length ?? 0) > 1 && <Chevron size={16} color={color.muted} />}
                </>
              )}
            </Glass>
          </Pressable>
        </View>
        {agent ? (
          <BarButton
            label={`${agent.name}'s session`}
            onPress={() => setCard((c) => !c)}
            ring={card}
          >
            <AgentMark client={agent.client} size={20} color={color.ink} />
          </BarButton>
        ) : (
          <View style={{ width: 44 }} />
        )}
      </GlassGroup>
      {card && agent && doc && (
        <SessionCard presence={agent} top={insets.top + 58} doc={doc} file={params.key} />
      )}
      {doc && !focusedBoard && <Hint bottom={insets.bottom} />}
      {doc && focusedBoard && (
        <WhereYouAre
          key={focusedBoard}
          doc={doc}
          artboardId={focusedBoard}
          agent={agents.find((a) => a.working.includes(focusedBoard))}
          bottom={insets.bottom}
        />
      )}
      {pending && (
        <Sheet
          testID="comment-sheet"
          onDismiss={() => {
            setPending(null);
            setSheet(0);
          }}
          onHeight={setSheet}
        >
          <Composer mode={mode} onMode={setMode} placeholder="Comment" onSend={createComment} />
          {error && (
            <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.muted }}>{error}</Text>
          )}
        </Sheet>
      )}
      {thread && (
        <ThreadSheet
          key={thread.id}
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
      )}
      {doc && (
        <PageMenu
          open={pages}
          top={insets.top + 58}
          pages={doc.pages}
          current={page?.id}
          onPick={(id) => {
            setPageId(id);
            canvas.current?.post({ t: "page", pageId: id });
            setPages(false);
          }}
          onClose={() => setPages(false)}
        />
      )}
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
 * "Hold to comment · Double-tap a screen to focus", each time a design opens:
 * it rises in over 0.4s, holds, and sinks out by 3.6s.
 */
function Hint({ bottom }: { bottom: number }) {
  const { color } = useTheme();
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(
      400,
      withSequence(
        withTiming(1, { duration: 400, easing: ease }),
        withDelay(2_100, withTiming(0, { duration: 400, easing: ease })),
      ),
    );
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ translateY: 12 * (1 - t.value) }, { scale: 0.96 + 0.04 * t.value }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", bottom: Math.max(34, bottom), alignSelf: "center", zIndex: 8 },
        style,
      ]}
    >
      <Glass
        style={{ height: 32, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" }}
      >
        <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.ink }}>
          Hold to comment · Double-tap a screen to focus
        </Text>
      </Glass>
    </Animated.View>
  );
}

/**
 * Where you are (Flow › 5 Focus), each time a board is focused: its name,
 * which of the page's boards it is, and how to zoom out; the agent's mark
 * when one works on it. It holds, then fades by 2.4s.
 */
function WhereYouAre({
  doc,
  artboardId,
  agent,
  bottom,
}: {
  doc: NonNullable<ReturnType<typeof useSessionState>["doc"]>;
  artboardId: string;
  agent?: Presence;
  bottom: number;
}) {
  const { color } = useTheme();
  const t = useSharedValue(1);
  useEffect(() => {
    t.value = withDelay(1_680, withTiming(0, { duration: 720, easing: ease }));
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: t.value }));
  const page = doc.pages.find((p) => p.artboards.some((a) => a.id === artboardId));
  const i = page?.artboards.findIndex((a) => a.id === artboardId) ?? -1;
  if (!page || i < 0) return null;
  return (
    <Animated.View
      pointerEvents="none"
      testID="where-you-are"
      style={[
        {
          position: "absolute",
          bottom: Math.max(104, bottom + 70),
          alignSelf: "center",
          zIndex: 8,
        },
        style,
      ]}
    >
      <Glass
        style={{
          height: 36,
          paddingLeft: agent ? 10 : 14,
          paddingRight: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        {agent && <AgentMark client={agent.client} size={14} color={color.ink} />}
        <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 13, color: color.ink }}>
          {page.artboards[i]!.name}
        </Text>
        <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.muted }}>
          {i + 1} of {page.artboards.length} · double-tap to zoom out
        </Text>
      </Glass>
    </Animated.View>
  );
}

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
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
      testID="session-card"
      style={{ position: "absolute", right: 16, top, width: 300, zIndex: 12 }}
    >
      <Glass style={{ borderRadius: 18, padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              backgroundColor: color.canvas,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AgentMark client={p.client} size={20} color={color.ink} />
          </View>
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
              style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 17.55, color: color.muted }}
            >
              {activity === "working"
                ? `Working${p.status ? ` · ${p.status}` : ""}`
                : "Iterating · watching for your comments"}
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

/** The title pill's page menu. */
function PageMenu({
  open,
  top,
  pages,
  current,
  onPick,
  onClose,
}: {
  open: boolean;
  top: number;
  pages: { id: string; name: string; icon?: string }[];
  current?: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { color, shadow, scheme } = useTheme();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: scheme === "dark" ? "rgba(0,0,0,0.35)" : "rgba(17,17,16,0.12)",
        }}
        onPress={onClose}
      />
      <View
        testID="page-menu"
        style={{
          position: "absolute",
          alignSelf: "center",
          top,
          width: 240,
          paddingVertical: 6,
          borderRadius: 14,
          backgroundColor: color.card,
          boxShadow: `${shadow.pop}, 0 0 0 1px ${color.hairline}`,
        }}
      >
        {pages.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => onPick(p.id)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              height: 44,
              paddingHorizontal: 14,
              backgroundColor: pressed ? color.canvas : "transparent",
            })}
          >
            <PageIcon name={p.icon} size={16} color={color.muted} />
            <Text
              style={{
                flex: 1,
                fontFamily: "Inter",
                fontWeight: "500",
                fontSize: 16,
                color: color.ink,
              }}
            >
              {p.name}
            </Text>
            {p.id === current && <Check size={16} color={color.ink} />}
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}
