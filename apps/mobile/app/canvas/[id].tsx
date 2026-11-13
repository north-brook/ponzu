import type { Person } from "@ponzu/client/model";
import { useSessionState } from "@ponzu/client/react";
import { linkTarget, type Thread } from "@ponzu/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type MenuAction, MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import { onlineManager } from "@tanstack/react-query";
import { type Href, router, useLocalSearchParams, useNavigation } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Pressable, Text, useWindowDimensions, View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
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
import { ChatSheet } from "../../components/chat-sheet";
import { BarButton } from "../../components/chrome";
import { Composer, initialMode, type Mode } from "../../components/composer";
import { DraftSheet } from "../../components/draft-sheet";
import { Glass, GlassGroup } from "../../components/glass";
import { Back, PageIcon } from "../../components/icons";
import { CanvasHint, MoveBar } from "../../components/move-bar";
import { PingAsk } from "../../components/ping-ask";
import { PrSheet } from "../../components/pr-sheet";
import { Sheet } from "../../components/sheet";
import { Shimmer } from "../../components/shimmer";
import { ThreadSheet } from "../../components/thread-sheet";
import {
  commit,
  newThreadOp,
  readOnlyLine,
  refusalWords,
  replyOp,
  type Spot,
  statusOp,
} from "../../lib/canvas/comments";
import { type LocalPicture, PicturePage, phonePictures } from "../../lib/canvas/pictures";
import { canvasStatus, previewUrl } from "../../lib/canvas/status";
import { useCanvasHead, useCanvasSource, useCanvasView } from "../../lib/canvas/use-canvas";
import { backend } from "../../lib/cloud/backend";
import { config } from "../../lib/cloud/config";
import { CANVAS_WORDS, COMMENT_WORDS } from "../../lib/copy";
import {
  draftKey,
  drafts,
  getDraft,
  moveDraft,
  setDraft,
  unsent,
  useDrafts,
} from "../../lib/drafts";
import { select, success, thud, tick } from "../../lib/haptics";
import { pathOf, threadLink } from "../../lib/links";
import { setListNotice } from "../../lib/list-notice";
import { pageIconImage } from "../../lib/page-icons";
import { safeHref } from "../../lib/prose";
import { canvasOnScreen, setOnScreen } from "../../lib/push/foreground";
import { dismissFor } from "../../lib/push/native";
import { canvasOf } from "../../lib/push/payload";
import { usePings } from "../../lib/push/pings";
import { Juice } from "../../lib/slice";
import { useTheme } from "../../lib/theme";
import { EASE_OUT } from "../../lib/tokens";
import { useSeen } from "../../lib/use-seen";
import { useWindowInsets } from "../../lib/window-insets";

const ease = Easing.bezier(...EASE_OUT);
/** The canvas's bar: 6pt above and below its 44pt controls. */
const BAR = 56;
/** The chat sheet's top edge, over the header's glass (board 3.8), below the status bar. */
const CHAT_TOP = 58;

// Unsent words are kept on disk, so an app iOS evicted or killed still has them (lib/drafts.ts).
drafts.setStorage(AsyncStorage);

/** Back where the canvas was opened from; opened by a link with nothing behind it, the list. */
function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/canvases");
}

/**
 * A canvas, live (iPhone design §7 and §8): its boards drawn in the web view from the replica on
 * this side (CloudSource, lib/canvas/use-canvas.ts, through lib/canvas/bridge.ts), with the app's
 * chrome over it: Back, the canvas's name in the middle (shimmering while the agent wakes or
 * works), the page button with the pages' native menu, and the floating stack (pull request,
 * Comment, Chat). Double-tap a board to focus it, and the chrome steps aside; pan and pinch as
 * on the Mac.
 *
 * Comments are left where they're about: hold on the canvas, or press Comment and tap, and the
 * field floats up, typed or said. A pin opens its thread, to read, reply, resolve or reopen.
 * Each is one op through the replica (lib/canvas/comments.ts): on the canvas at once, its words
 * kept in their draft (lib/drafts.ts, on disk) until the API has them. Chat opens the canvas's
 * thread in its sheet (components/chat-sheet.tsx), to read Ponzu, say something, attach
 * pictures or stop a turn. The pull request button, shown once the canvas has one, opens its
 * sheet (components/pr-sheet.tsx), to look it over and take its next action, Merge among them.
 *
 * Opened from a row, a link or a push: `page` and `artboard` say where to open (a board on its
 * page, or a page, as @ponzu/core's `linkTarget` reads them); `sheet=chat` opens the chat, at
 * `message=<seq>` when it names one, and `question=<id>` (a push's) opens it at that question;
 * `sheet=pull-request` opens the pull request sheet. A tap on a ping adds `ping=<id>`: a canvas
 * the person can no longer open then goes back to the canvases with a line saying so.
 *
 * While it is on screen with the app in front, a ping about it shows no banner, the pings about
 * it leave Notification Center, and (while the API sends pings) its presence says the person is
 * looking, so the API holds back pings about it. After the first comment sent from this phone,
 * it may ask about pings (components/ping-ask.tsx).
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
    ping?: string;
  }>();
  const canvasId = params.id;
  const { color, scheme } = useTheme();
  const safe = useSafeAreaInsets();
  // The window's, the rail at the side included.
  const windowInsets = useWindowInsets();
  const insets = { ...safe, left: windowInsets.left, right: windowInsets.right };
  const { width } = useWindowDimensions();
  const { source, bridge, state, me } = useCanvasSource(canvasId);
  const session = useSessionState(backend.session);
  /** The person's GitHub login: on the pull request, their own words read "You". */
  const viewerLogin = session.status === "signed_in" ? session.user.githubLogin : null;
  const head = useCanvasHead(canvasId);
  const view = useCanvasView(canvasId);
  const doc = state.doc;
  const status = canvasStatus(head, state);
  const pings = usePings();
  const canvas = useRef<CanvasHandle>(null);
  /**
   * The person may comment: the API said they can push to its repo, and it is open (not the last
   * copy shown offline, not gone). Offline after it opened, a comment still goes, and waits.
   */
  const writable = Boolean(source?.writable) && state.status !== "error";
  const readOnly = readOnlyLine({
    writable,
    status: state.status,
    hasDoc: Boolean(doc),
    repo: view.data?.repo?.fullName,
  });
  const writableRef = useRef(writable);
  writableRef.current = writable;

  // Unsent words from before, from disk; and those sent before the app last stopped that the
  // API's canvas shows got there go (lib/drafts.ts `settle`). Only the API's own doc says so.
  const [draftsIn, setDraftsIn] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void drafts.load(canvasId).then(() => {
      if (live) setDraftsIn(canvasId);
    });
    return () => {
      live = false;
      // Its CloudSource closes with the screen and drops what it was waiting to send: what was
      // sent and not answered is settled from the API's doc on the next open, not left "sending".
      drafts.release(canvasId);
    };
  }, [canvasId]);
  useEffect(() => {
    if (doc && state.status === "ready" && draftsIn === canvasId) drafts.settle(canvasId, doc);
  }, [doc, state.status, canvasId, draftsIn]);

  // The page draws from the canvas's own files: known from the replica, or first from the view.
  const assetsUrl = source?.assetBase ?? view.data?.assetsUrl ?? null;
  const name = head?.name ?? view.data?.name ?? (state.path || doc?.name || "");

  // The picture of where each comment and reply the person sends was left, drawn by the page as
  // it is sent and kept with it once the API has it, as the Mac does (lib/canvas/pictures.ts).
  const picturePage = useMemo(() => new PicturePage((msg) => canvas.current?.post(msg)), []);
  useEffect(() => () => picturePage.close(), [picturePage]);
  const [pictures, setPictures] = useState<ReadonlyMap<string, LocalPicture>>(() => new Map());
  useEffect(() => {
    if (!source || !me) return;
    const made = phonePictures({
      canvasId,
      meId: me.id,
      source,
      api: backend.api.canvases,
      page: picturePage,
    }).start();
    const off = made.subscribe(() => setPictures(made.getSnapshot()));
    return () => {
      off();
      made.close();
      setPictures(new Map());
    };
  }, [source, me?.id, canvasId, picturePage]);

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

  // On screen with the app in front: a ping about this canvas shows no banner, those already
  // shown leave Notification Center, and the API hears the person is looking (only while it
  // sends pings, so nothing changes until then).
  const looking = useSeen();
  useEffect(() => {
    if (looking) {
      setOnScreen(canvasId);
      void dismissFor(canvasId, canvasOf);
    } else if (canvasOnScreen() === canvasId) setOnScreen(null);
  }, [looking, canvasId]);
  useEffect(
    () => () => {
      if (canvasOnScreen() === canvasId) setOnScreen(null);
    },
    [canvasId],
  );
  useEffect(() => {
    if (pings.on) source?.setFocused(looking);
  }, [source, looking, pings.on]);

  // Opened from a ping, and no longer the person's to open: back to the canvases, saying so.
  useEffect(() => {
    if (!params.ping || status.mood !== "gone") return;
    setListNotice(CANVAS_WORDS.gone);
    router.dismissTo("/canvases");
  }, [params.ping, status.mood]);

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

  /* Comments (iPhone design §8). */
  /** Where a new comment is being written: the floating field is up. */
  const [pending, setPending] = useState<Spot | null>(null);
  /** The Comment button was pressed: the next tap on the canvas drops the pin. */
  const [placing, setPlacing] = useState(false);
  /** An unsent comment's pin, held: Open, Move and Discard draft, by its draft's key. */
  const [holding, setHolding] = useState<string | null>(null);
  /** An unsent comment's pin being moved, by its draft's key: it holds still, the canvas moves. */
  const [movingDraft, setMovingDraft] = useState<string | null>(null);
  /** A sent comment's field on its way out, and whose pin it was. */
  const sent = useRef<{ pin: Spot } | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** The thread whose sheet is open; a link or a push may name one. */
  const [threadId, setThreadId] = useState<string | null>(params.thread ?? null);
  useEffect(() => {
    if (params.thread) setThreadId(params.thread);
  }, [params.thread]);
  /**
   * The chat sheet is up (iPhone design §9): opened by Chat, or by a link or push (`sheet=chat`,
   * and maybe `message=<seq>` to open at). Only by Chat does its field take the keyboard.
   */
  const [chat, setChat] = useState(params.sheet === "chat");
  const [chatFocus, setChatFocus] = useState(false);
  /**
   * The pull request sheet is up (iPhone design §11): opened by the stack's button, a pull
   * request line in the chat, or a link or push (`sheet=pull-request`).
   */
  const [pullRequest, setPullRequest] = useState(params.sheet === "pull-request");
  useEffect(() => {
    if (params.sheet === "pull-request") {
      setChat(false);
      setPullRequest(true);
      return;
    }
    if (params.sheet !== "chat") return;
    setPullRequest(false);
    setChatFocus(false);
    setChat(true);
  }, [params.sheet, params.message, params.question, params.ping]);
  const chatQuestion =
    params.question && /^[A-Za-z0-9_-]{1,64}$/.test(params.question) ? params.question : null;
  const chatMessage =
    params.message && /^\d{1,15}$/.test(params.message) ? Number(params.message) : null;
  const [mode, setMode] = useState<Mode>(initialMode);
  /** How far a sheet over the canvas rises: the pin it's about stays above it. */
  const [sheet, setSheet] = useState(0);
  /** Why the comment being written didn't go, under its field. */
  const [error, setError] = useState<string | null>(null);
  /** Why a reply, Resolve or Reopen didn't go, in the thread's sheet. */
  const [note, setNote] = useState<string | null>(null);
  /** Why something sent from a sheet that has since closed didn't go: under the title. */
  const [notice, setNotice] = useState<string | null>(null);
  /** The ask about pings, after a comment sent from this phone (lib/push/ask.ts). */
  const [asking, setAsking] = useState(false);
  /** Comments, replies and resolves sent and not yet answered. */
  const [waiting, setWaiting] = useState(0);
  const thread = doc?.threads.find((t) => t.id === threadId) ?? null;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const threadRef = useRef(thread);
  threadRef.current = thread;

  /** A comment left unsent: its field comes back with its words, as a hold would bring it. */
  const openDraft = (key: string) => {
    const pin = getDraft(key)?.pin;
    if (!pin || !writableRef.current) return;
    tick();
    setThreadId(null);
    setPlacing(false);
    setNotice(null);
    sent.current = null;
    setLeaving(false);
    setError(null);
    setPending(pin);
  };
  const openDraftRef = useRef(openDraft);
  openDraftRef.current = openDraft;

  const onMessage = useCallback(
    (msg: FromCanvas) => {
      switch (msg.t) {
        case "longpress":
          // Only on a canvas the person can steer; on one they can look at, a hold does nothing.
          if (!writableRef.current) break;
          // The pin is dropped: the field takes the screen, so a thread's sheet gives way.
          tick();
          setThreadId(null);
          setHolding(null);
          setPlacing(false);
          setNotice(null);
          // A sent comment's field still on its way out comes back up for this one.
          sent.current = null;
          setLeaving(false);
          setError(null);
          setPending({
            pageId: msg.pageId,
            ...(msg.artboardId ? { artboardId: msg.artboardId } : {}),
            ...(msg.nodeId ? { nodeId: msg.nodeId } : {}),
            ...(msg.offset ? { offset: msg.offset } : {}),
            x: msg.x,
            y: msg.y,
          });
          break;
        case "tap":
          // Writing, a tap on the canvas puts the keyboard down; the field rides it.
          KeyboardController.dismiss().catch(() => {});
          break;
        case "openThread":
          setPending(null);
          setPlacing(false);
          setNote(null);
          setNotice(null);
          setThreadId(msg.id);
          break;
        case "openUnsent":
          openDraftRef.current(msg.key);
          break;
        case "holdUnsent":
          // Read only, a hold does nothing here either: Move and Discard are for a canvas the
          // person may comment on. The words stay in their draft.
          if (!writableRef.current) break;
          // Its sheet takes the place of whatever was up, as a hold's field does.
          tick();
          setThreadId(null);
          setPending(null);
          setPlacing(false);
          setHolding(msg.key);
          break;
        case "moved": {
          // The draft's words go with its pin, kept under the key its new spot makes.
          const to = {
            pageId: msg.pageId,
            ...(msg.artboardId ? { artboardId: msg.artboardId } : {}),
            ...(msg.nodeId ? { nodeId: msg.nodeId } : {}),
            ...(msg.nodeId && msg.offset ? { offset: msg.offset } : {}),
            x: msg.x,
            y: msg.y,
          };
          moveDraft(msg.key, draftKey.comment(canvasId, to), to);
          break;
        }
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
        case "picture":
          picturePage.heard(msg);
          break;
      }
    },
    [canvasId, picturePage],
  );

  /** Sent, and answered: a refusal's words go where the person will see them. */
  const track = async (sending: Promise<void>, refused: (words: string) => void) => {
    setWaiting((n) => n + 1);
    try {
      await sending;
    } catch (err) {
      refused(refusalWords(err));
      throw err;
    } finally {
      setWaiting((n) => n - 1);
    }
  };

  /** The sent comment's field is off the screen: its pin goes, unless another was dropped since. */
  const left = () => {
    const pin = sent.current?.pin;
    sent.current = null;
    setLeaving(false);
    setPending((p) => (p === pin ? null : p));
    setSheet(0);
  };
  const createComment = async (text: string, _mode: Mode) => {
    // Not open yet: the words stay in the field, as for any send that didn't go.
    if (!source || !pending || !me) throw new Error("The canvas isn't open yet.");
    const pin = pending;
    const key = draftKey.comment(canvasId, pin);
    const op = newThreadOp(pin, text, me);
    // Its words stay in their draft until the API has them; the field leaves at once, and the
    // comment is on the canvas the moment it's applied.
    drafts.markSending(key, op.thread.id);
    sent.current = { pin };
    setError(null);
    setLeaving(true);
    await track(commit(source, op), (words) => {
      drafts.markSending(key, undefined);
      // The words come back where they were left: the field over its pin, unless something
      // else is up by now, when the pin stays as an unsent comment and the title says why.
      if (sent.current?.pin === pin) {
        sent.current = null;
        setLeaving(false);
        setError(words);
      } else if (!pendingRef.current && !threadRef.current) {
        setPending(pin);
        setError(words);
      } else setNotice(words);
    });
    // The API has it: the first comment from this phone may ask about pings.
    if (await pings.afterComment().catch(() => false)) setAsking(true);
  };
  const reply = async (text: string, _mode: Mode) => {
    if (!source || !thread || !me) throw new Error("The canvas isn't open yet.");
    const key = draftKey.reply(canvasId, thread.id);
    const { op, messageId } = replyOp(thread, text, me);
    drafts.markSending(key, messageId);
    setNote(null);
    await track(commit(source, op), (words) => {
      drafts.markSending(key, undefined);
      if (threadRef.current?.id === thread.id) setNote(words);
      else setNotice(words);
    });
  };
  const setStatus = async (next: Thread["status"]) => {
    if (!source || !thread) return;
    const id = thread.id;
    setNote(null);
    const sending = commit(source, statusOp(id, next));
    // Resolved, it's done with: the sheet closes as it's sent.
    if (next === "resolved") {
      success();
      setThreadId(null);
      setSheet(0);
    }
    await track(sending, (words) => {
      if (threadRef.current?.id === id) setNote(words);
      else setNotice(words);
    });
  };

  /* The chat (iPhone design §9). */
  /** The person as the thread names them: their bubbles, until the API's own items come. */
  const chatMe = useMemo<Person | null>(
    () =>
      me
        ? { id: me.id ?? "", name: me.name, login: me.name, avatarUrl: me.avatarUrl ?? null }
        : null,
    [me],
  );
  const openChat = () => {
    tick();
    setThreadId(null);
    setPending(null);
    setPlacing(false);
    setHolding(null);
    setNotice(null);
    setPullRequest(false);
    setChatFocus(true);
    setChat(true);
  };
  /** The chat is gone: the thread is read as far as it held. */
  const closeChat = (readSeq: number | null) => {
    setChat(false);
    setChatFocus(false);
    if (head) {
      backend.api.canvases
        .seen(canvasId, { seq: head.seq, ...(readSeq !== null ? { threadSeq: readSeq } : {}) })
        .catch(() => {});
    }
  };
  /** The pull request sheet, from the stack's button: whatever else was up gives way. */
  const openPullRequest = () => {
    tick();
    setThreadId(null);
    setPending(null);
    setPlacing(false);
    setHolding(null);
    setNotice(null);
    setPullRequest(true);
  };
  /** A pull request line in the chat: the chat is read as far as it held, and the sheet opens. */
  const openPullRequestFromChat = (readSeq: number | null) => {
    closeChat(readSeq);
    setPullRequest(true);
  };
  /** Shows a page, or a board on its page, from the chat: the sheet has gone by then. */
  const showPlace = (at: { pageId?: string; artboardId?: string }) => {
    const pageOf = at.artboardId
      ? doc?.pages.find((p) => p.artboards.some((a) => a.id === at.artboardId))?.id
      : at.pageId;
    if (pageOf && doc?.pages.some((p) => p.id === pageOf) && pageOf !== page?.id) {
      setPageId(pageOf);
      canvas.current?.post({ t: "page", pageId: pageOf });
    }
    if (at.artboardId && pageOf) canvas.current?.post({ t: "focus", artboardId: at.artboardId });
  };
  /** A comment's picture in the chat: the sheet goes, the canvas goes to the pin, its thread opens. */
  const openCommentFromChat = (id: string, readSeq: number | null) => {
    closeChat(readSeq);
    const pin = doc?.threads.find((t) => t.id === id);
    if (!pin) return;
    showPlace(pin.artboardId ? { artboardId: pin.artboardId } : { pageId: pin.pageId });
    setThreadId(id);
  };
  /**
   * A link in Ponzu's reply: a page or board of this canvas is shown in place, with the sheet
   * gone; another canvas opens, with this one's sheet closed and its thread read as a swipe
   * leaves it; anything else prose.ts let through leaves the app.
   */
  const openLink = (url: string, readSeq: number | null) => {
    const route = threadLink(url, config().scheme);
    if (route?.id === canvasId) {
      closeChat(readSeq);
      showPlace({ pageId: route.params.page, artboardId: route.params.artboard });
      return;
    }
    if (route) {
      closeChat(readSeq);
      router.push(pathOf(route) as Href);
      return;
    }
    const href = safeHref(url);
    if (!href) return;
    if (/^mailto:/i.test(href)) Linking.openURL(href).catch(() => {});
    else WebBrowser.openBrowserAsync(href).catch(() => {});
  };

  // Unsent words for this canvas: the pins of new comments left unsent (but the one being
  // written, and those on their way), and the threads with a reply being written.
  const allDrafts = useDrafts();
  const pinDraft = pending ? draftKey.comment(canvasId, pending) : undefined;
  const unsentPins = useMemo(
    () =>
      page
        ? allDrafts.flatMap(([key, d]) =>
            d.file === canvasId &&
            d.pin &&
            unsent(d) &&
            key !== pinDraft &&
            !drafts.isSending(key) &&
            (d.pin.artboardId
              ? page.artboards.some((a) => a.id === d.pin!.artboardId)
              : d.pin.pageId === page.id)
              ? [{ key, ...d.pin }]
              : [],
          )
        : [],
    [allDrafts, page, pinDraft, canvasId],
  );
  const writingKey = useMemo(() => {
    const ids = new Set(doc?.threads.map((t) => t.id));
    return [
      ...new Set(
        allDrafts.flatMap(([, d]) =>
          d.file === canvasId && d.thread && unsent(d) && ids.has(d.thread) ? [d.thread] : [],
        ),
      ),
    ].join(" ");
  }, [allDrafts, doc, canvasId]);
  const writingIds = useMemo(() => (writingKey ? writingKey.split(" ") : []), [writingKey]);
  // Another page: a pin being moved stays where it was.
  useEffect(() => setMovingDraft(null), [page?.id]);
  // No longer the person's to steer (a lost push access, the canvas gone): nothing half-written
  // stays up. Its words stay in their draft.
  useEffect(() => {
    if (writable) return;
    setPending(null);
    setPlacing(false);
    setHolding(null);
    setMovingDraft(null);
  }, [writable]);

  // Writing or reading a comment keeps the chrome, focused board or not.
  const bare = Boolean(focusedBoard) && !moving && !pending && !thread && !holding;
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
  // Under the title, most pressing first: a comment that didn't go, one waiting to, the canvas.
  const queued = waiting > 0 && state.status === "offline" ? COMMENT_WORDS.queued : null;
  const line = notice ?? queued ?? (placeholderLine ? null : status.line);
  const sheetUp = Boolean(
    pending || thread || holding || movingDraft || chat || pullRequest || asking,
  );
  const offline =
    state.status === "offline" || !onlineManager.isOnline() ? CANVAS_WORDS.offline : null;
  const foot = Math.max(insets.bottom, 16) + 8;
  return (
    <View testID="canvas" style={{ flex: 1, backgroundColor: color.canvas }}>
      {bridge && assetsUrl && (
        <CanvasView
          ref={canvas}
          assetsUrl={assetsUrl}
          bridge={bridge}
          theme={scheme}
          insets={canvasInsets}
          sheet={sheet}
          pending={pending}
          commenting={placing}
          unsent={unsentPins}
          writing={writingIds}
          thread={threadId}
          moving={movingDraft}
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
      {!bare && !sheetUp && (
        <CanvasStack
          bottom={foot}
          right={16 + insets.right}
          prNumber={head?.prNumber ?? null}
          onPullRequest={openPullRequest}
          chat={status.chat}
          onChat={openChat}
          commenting={placing}
          commentHint={readOnly}
          onComment={
            writable
              ? () => {
                  tick();
                  setThreadId(null);
                  setNotice(null);
                  setPlacing((p) => !p);
                }
              : undefined
          }
        />
      )}
      {placing && !sheetUp && <CanvasHint text={COMMENT_WORDS.place} bottom={foot + 8} />}
      {pending && (
        <Sheet
          testID="comment-sheet"
          // No sheet: the field alone floats over the canvas, above the keyboard.
          bare
          right={insets.right}
          onDismiss={() => {
            setPending(null);
            setError(null);
            setSheet(0);
          }}
          onHeight={setSheet}
          away={leaving}
          onAway={left}
        >
          <Composer
            mode={mode}
            onMode={setMode}
            placeholder="Comment"
            onSend={createComment}
            leaves
            // One field per pin: a pin dropped while the last comment is still sending gets its
            // own, which that send's answer can't empty.
            key={pinDraft}
            draft={{ key: pinDraft!, file: canvasId, pin: pending }}
          />
          {error && (
            // On glass, as it floats over the canvas with the field.
            <Glass
              style={{
                alignSelf: "flex-start",
                borderRadius: 14,
                paddingHorizontal: 12,
                paddingVertical: 6,
              }}
            >
              <Text
                testID="comment-error"
                style={{ fontFamily: "Inter", fontSize: 13, color: color.muted }}
              >
                {error}
              </Text>
            </Glass>
          )}
        </Sheet>
      )}
      {holding &&
        (() => {
          const d = getDraft(holding);
          if (!d) return null;
          return (
            <DraftSheet
              text={d.text}
              right={insets.right}
              onOpen={() => {
                setHolding(null);
                openDraft(holding);
              }}
              onMove={() => {
                select();
                setHolding(null);
                setMovingDraft(holding);
              }}
              onDiscard={() => {
                thud();
                setDraft(holding, { ...d, text: "" });
                setHolding(null);
              }}
              onDismiss={() => setHolding(null)}
            />
          );
        })()}
      {movingDraft && (
        <MoveBar
          key={movingDraft}
          bottom={Math.max(34, insets.bottom)}
          left={0}
          width={width - insets.right}
          onDone={() => {
            tick();
            canvas.current?.post({ t: "place" });
            setMovingDraft(null);
          }}
        />
      )}
      {chat && chatMe && (
        <ChatSheet
          canvasId={canvasId}
          head={head}
          canvas={view.data}
          doc={doc}
          me={chatMe}
          pictures={pictures}
          readOnly={readOnly}
          offline={offline}
          focus={chatFocus && (head?.needsYouCount ?? 0) === 0}
          message={chatMessage}
          question={chatQuestion}
          repoName={view.data?.repo?.fullName ?? null}
          onDismiss={closeChat}
          onOpenComment={openCommentFromChat}
          onOpenLink={openLink}
          onOpenPullRequest={openPullRequestFromChat}
          top={Math.max(CHAT_TOP, safe.top + 4)}
          right={insets.right}
        />
      )}
      {/* Only once the canvas is open for the person signed in now (`me`), as the chat. */}
      {pullRequest && !chat && me && (
        <PrSheet
          canvasId={canvasId}
          head={head}
          viewerLogin={viewerLogin}
          blocked={readOnly ?? offline}
          onDismiss={() => setPullRequest(false)}
          top={Math.max(CHAT_TOP, safe.top + 4)}
          right={insets.right}
        />
      )}
      {/* After the comment's field has gone, and over nothing else. */}
      {asking && !pending && !thread && !holding && !chat && !pullRequest && (
        <PingAsk
          right={insets.right}
          onTurnOn={async () => {
            await pings.turnOn();
            setAsking(false);
          }}
          onNotNow={() => {
            setAsking(false);
            void pings.notNow();
          }}
        />
      )}
      {thread && !pending && (
        <ThreadSheet
          key={thread.id}
          right={insets.right}
          thread={thread}
          me={me ?? { id: "", name: "" }}
          file={canvasId}
          onReply={reply}
          onStatus={setStatus}
          readOnly={readOnly}
          note={note ?? queued}
          onDismiss={() => {
            setThreadId(null);
            setNote(null);
            setSheet(0);
          }}
          onHeight={setSheet}
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
