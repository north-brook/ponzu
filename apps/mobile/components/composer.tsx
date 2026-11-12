import {
  Host,
  Text as SwiftText,
  TextField,
  type TextFieldRef,
  useNativeState,
} from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  lineLimit,
  lineSpacing,
  padding,
  disabled as swiftDisabled,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardController } from "react-native-keyboard-controller";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useAppActive } from "../lib/app-active";
import { useDictation } from "../lib/dictation";
import { type Draft, getDraft, setDraft } from "../lib/drafts";
import { FIELD_LINE, FIELD_LINES, FIELD_PAD, FIELD_SIZE, FIELD_SPACING } from "../lib/field";
import { fail, select, success } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { brand, EASE_OUT } from "../lib/tokens";
import { Glass } from "./glass";
import { Keyboard, Mic, MicOff, Send } from "./icons";

export type Mode = "voice" | "type";

const MODE_KEY = "ponzu.commentMode";
let lastMode: Mode = "voice";
AsyncStorage.getItem(MODE_KEY)
  .then((m) => {
    if (m === "voice" || m === "type") lastMode = m;
  })
  .catch(() => {});

/** The mode a comment sheet opens in: the one used last. */
export function initialMode(): Mode {
  return lastMode;
}

function rememberMode(m: Mode) {
  lastMode = m;
  AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
}

const ease = Easing.bezier(...EASE_OUT);

const styles = StyleSheet.create({
  // Out of view, never faded: Liquid Glass draws as a plain view under a parent with opacity.
  hidden: { position: "absolute", left: -10_000, width: 300 },
});
/** A control inside the field: its size, and how far it sits in from the field's edge. */
const SLOT = 32;
const INSET = (44 - SLOT) / 2;
/** Text beside a control clears it by this much more. */
const BESIDE = INSET + SLOT + 8;
/** The text's own inset, with nothing beside it. */
const EDGE = 16;

/**
 * Writing a comment or reply, by voice or typing: one glass field and
 * nothing else (Directions › A+ in .context/composer.design). What's typed
 * and what's said are written in the same field, five lines at most.
 *
 * Typing, it's SwiftUI's own text field, with the mic inside its trailing
 * edge (switch to voice) until there are words, then Send. In voice, what's
 * heard is written into the field as it's said, the listening disc at its
 * leading edge mutes (tap again to listen), and the keyboard glyph goes back
 * to typing until there are words, then Send. A tap on what's been said goes
 * back to typing too, the words with it, to fix one.
 *
 * A new comment's field floats on its own over the canvas (sheet.tsx, bare);
 * a thread's reply field sits in the thread's sheet.
 */
export function Composer({
  mode,
  onMode,
  placeholder,
  onSend,
  autoFocus = true,
  draft,
  leaves = false,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  /** "Comment" or "Reply". */
  placeholder: string;
  onSend: (text: string, mode: Mode) => Promise<void> | void;
  /** Focus the field when typing starts. A thread's reply field waits for a tap. */
  autoFocus?: boolean;
  /**
   * What the unsent words are kept under (lib/drafts.ts: a pin's place, a thread's id), so
   * they come back wherever the composer opens next.
   */
  draft?: { key: string } & Omit<Draft, "text">;
  /** Sending takes the field away (a new comment): the words go with it, never emptied first. */
  leaves?: boolean;
}) {
  const { color } = useTheme();
  const voice = mode === "voice";
  /** Sent from a field that leaves: the microphone stops with the tap, not when the Mac answers. */
  const [gone, setGone] = useState(false);
  const [kept] = useState(() => (draft ? (getDraft(draft.key)?.text ?? "") : ""));
  /**
   * Words sent and not yet answered. Their draft keeps them until the send is (iPhone design
   * §8: an app killed in between still has them), whatever the field shows meanwhile; what's
   * typed after them is kept with them.
   */
  const inFlight = useRef<string | null>(null);
  const keep = (t: string) => {
    if (!draft) return;
    const sending = getDraft(draft.key)?.sending;
    const text = inFlight.current ? [inFlight.current, t.trim()].filter(Boolean).join(" ") : t;
    setDraft(draft.key, {
      file: draft.file,
      thread: draft.thread,
      pin: draft.pin,
      text,
      ...(sending ? { sending } : {}),
    });
  };
  /** Sent and answered: the draft goes, and only what's been written since stays. */
  const landed = (since: string) => {
    if (!draft) return;
    setDraft(draft.key, { file: draft.file, thread: draft.thread, pin: draft.pin, text: "" });
    if (since) keep(since);
  };
  // Opened in voice, it goes on from what was said or typed before.
  const dictation = useDictation(voice && !gone, voice ? kept : "");
  // The field's words live in SwiftUI (field); typed follows them for Send and the draft.
  const field = useNativeState(voice ? "" : kept);
  const [typed, setTypedState] = useState(voice ? "" : kept);
  /** The person typed: SwiftUI has the words already. */
  const onType = (t: string) => {
    keep(t);
    setTypedState(t);
  };
  /** The app puts words in the field (what was said, a send, a send that failed). */
  const setTyped = (t: string) => {
    field.value = t;
    onType(t);
  };
  // What's heard is kept as it comes, as typing is.
  useEffect(() => {
    if (voice) keep(dictation.text);
  }, [voice, dictation.text]);
  const [sending, setSending] = useState(false);
  const input = useRef<TextFieldRef>(null);
  const text = voice ? dictation.text : typed;
  const has = text.trim().length > 0;

  const switchTo = (m: Mode) => {
    select();
    // What was said carries into typing, and back.
    if (m === "type") setTyped(dictation.text);
    else {
      dictation.setText(typed);
      // The keyboard goes down with the system's own animation; the field rides it.
      KeyboardController.dismiss().catch(() => {});
    }
    rememberMode(m);
    onMode(m);
  };
  const first = useRef(true);
  useEffect(() => {
    const was = first.current;
    first.current = false;
    // The keyboard comes up as typing starts, and the field rides it.
    if (!voice && (autoFocus || !was))
      setTimeout(() => input.current?.focus().catch(() => {}), was ? 60 : 0);
  }, [mode]);

  // The mode and the words now, for a send that fails: its words go back into whichever
  // the person is using by then, ahead of anything they've added since.
  const now = useRef({ voice, typed, said: dictation.text });
  now.current = { voice, typed, said: dictation.text };
  const send = async () => {
    if (!has || sending) return;
    const words = text.trim();
    setSending(true);
    inFlight.current = words;
    // Something answers the tap at once, not when Ponzu does: on a phone's network that's long
    // enough to read as a tap that didn't take. A field that leaves takes the words with it; a
    // reply's leave the field. A send that fails puts them back.
    if (leaves) setGone(true);
    else {
      setTyped("");
      dictation.setText("");
    }
    try {
      await onSend(words, mode);
      success();
      inFlight.current = null;
      if (leaves) {
        setTyped("");
        dictation.setText("");
        landed("");
      } else {
        const n = now.current;
        landed((n.voice ? n.said : n.typed).trim());
      }
    } catch {
      inFlight.current = null;
      // A field that leaves comes back with its words, listening again as it did when it opened.
      if (leaves) setGone(false);
      else {
        const n = now.current;
        const since = (n.voice ? n.said : n.typed).trim();
        const back = since ? `${words} ${since}` : words;
        if (n.voice) dictation.setText(back);
        else setTyped(back);
      }
      // The screen says what went wrong; this says it didn't go.
      fail();
    } finally {
      setSending(false);
    }
  };

  const blocked = dictation.state === "denied" || dictation.state === "unavailable";
  const note =
    dictation.state === "denied"
      ? "Ponzu can't hear you. Turn on the microphone and speech recognition in Settings, or type."
      : dictation.state === "unavailable"
        ? "Dictation isn't available on this iPhone. Type instead."
        : null;
  const spoken = dictation.text.trim().length > 0;

  return (
    <Glass
      testID="comment-field"
      style={{ minHeight: 44, borderRadius: 22, justifyContent: "flex-end" }}
    >
      {/*
        SwiftUI's own text field, as Messages' is: one line at 44, a line taller for
        each line of text up to five, then it scrolls in itself, keeping the line being
        typed in view. SwiftUI sizes it and the host takes its height
        (matchContents), so nothing here measures it. It isn't React Native's, so it
        holds no touch Send needs. In voice it steps out of view (moved, never faded:
        glass breaks under opacity) and what's heard takes its place.
      */}
      <View
        style={voice ? styles.hidden : { paddingRight: BESIDE - EDGE }}
        pointerEvents={voice ? "none" : "auto"}
        accessibilityElementsHidden={voice}
        importantForAccessibility={voice ? "no-hide-descendants" : "auto"}
      >
        <Host matchContents={{ vertical: true }} alignment="bottomLeading">
          <TextField
            ref={input}
            text={field}
            onTextChange={onType}
            axis="vertical"
            testID={voice ? undefined : "comment-input"}
            modifiers={[
              // Relative to body, so it follows Dynamic Type as the rest of the app does.
              font({ family: "Inter", size: FIELD_SIZE, textStyle: "body" }),
              foregroundStyle(color.ink),
              tint(brand.yuzu),
              lineLimit({ min: 1, max: FIELD_LINES }),
              lineSpacing(FIELD_SPACING),
              padding({ horizontal: EDGE, vertical: FIELD_PAD }),
              swiftDisabled(voice),
            ]}
          >
            <TextField.Placeholder>
              <SwiftText modifiers={[foregroundStyle(color.faint)]}>{placeholder}</SwiftText>
            </TextField.Placeholder>
          </TextField>
        </Host>
      </View>
      {voice && (
        // What's heard, written into the field as it's said. A tap goes back to typing with it.
        <Pressable
          onPress={() => switchTo("type")}
          accessibilityRole="button"
          accessibilityHint="Type to change it"
          style={{
            minHeight: 44,
            justifyContent: "center",
            paddingVertical: (44 - FIELD_LINE) / 2,
            paddingLeft: BESIDE,
            paddingRight: BESIDE,
          }}
        >
          <Text
            testID="transcript"
            numberOfLines={FIELD_LINES}
            ellipsizeMode="head"
            style={{
              fontFamily: "Inter",
              fontSize: FIELD_SIZE,
              lineHeight: FIELD_LINE,
              color: spoken ? color.ink : color.faint,
            }}
          >
            {spoken ? dictation.text : <Caret />}
            {spoken ? <Caret /> : (note ?? (dictation.muted ? "Muted" : "Listening…"))}
          </Text>
        </Pressable>
      )}
      {voice && (
        <View style={{ position: "absolute", left: INSET, bottom: INSET }}>
          <ListenDisc
            level={dictation.level}
            muted={dictation.muted}
            blocked={blocked}
            listening={dictation.state === "listening"}
            onPress={() => {
              select();
              dictation.setMuted(!dictation.muted);
            }}
          />
        </View>
      )}
      <View style={{ position: "absolute", right: INSET, bottom: INSET }}>
        {has ? (
          <InkButton label="Send" onPress={send} disabled={sending} testID="send">
            <Send size={16} color={color.bg} />
          </InkButton>
        ) : voice ? (
          <GlyphButton label="Type instead" testID="to-type" onPress={() => switchTo("type")}>
            <Keyboard color={color.muted} />
          </GlyphButton>
        ) : (
          <GlyphButton label="Speak instead" testID="to-voice" onPress={() => switchTo("voice")}>
            <Mic color={color.muted} />
          </GlyphButton>
        )}
      </View>
    </Glass>
  );
}

/** The caret's height in the line, under Inter's ascender so it never makes the line taller. */
const CARET = 14;

/**
 * The yuzu caret, drawn 2×22 from a descender's depth up. In the line it's
 * CARET tall, sitting on the baseline: an inline view taller than the font's
 * ascender stretches its line, which pushed the field past 44 and set the
 * words and its controls low. It's scaled to 22 about its middle, which a
 * 14pt view on the baseline shares with 22pt reaching 4pt below it.
 */
function Caret() {
  return (
    <Text>
      <View
        style={{
          width: 2,
          height: CARET,
          marginHorizontal: 2,
          backgroundColor: brand.yuzu,
          transform: [{ scaleY: FIELD_LINE / CARET }],
        }}
      />
    </Text>
  );
}

/** A glyph inside the field (switch to typing or voice): no glass of its own, the field's is. */
function GlyphButton({
  children,
  onPress,
  label,
  testID,
}: {
  children: React.ReactNode;
  onPress: () => void;
  label: string;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={8}
      style={slot}
    >
      <Animated.View key={label} entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

/**
 * The ink button (Send), pressed through a native tap recognizer of its own
 * rather than React Native's responder system, which runs a press in
 * JavaScript from the touches the root view sees. There a tap on Send could
 * reach the button and never start its press, so that the next tap sent: a
 * responder the field still held after a tap in it refused to let go (#367
 * saw to that one), and the press judges where a touch is by the first of
 * every finger on the display, so a thumb resting on the canvas puts it
 * outside the button. UIKit hands the recognizer only the touches on the
 * button, and nothing in JavaScript gets to refuse or misplace them. It
 * scales down while held, as before, on the UI thread.
 */
function InkButton({
  children,
  onPress,
  label,
  disabled,
  testID,
}: {
  children: React.ReactNode;
  onPress: () => void;
  label: string;
  disabled: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  const held = useSharedValue(0);
  // The latest press, so the recognizer isn't rebuilt on every render.
  const press = useRef(onPress);
  press.current = onPress;
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .enabled(!disabled)
        // Held as long as it likes and let go within reach, as the system's buttons take a press.
        .maxDuration(10_000)
        .maxDistance(24)
        .onBegin(() => {
          held.value = withTiming(1, { duration: 80, easing: ease });
        })
        .onEnd(() => press.current())
        .onFinalize(() => {
          held.value = withTiming(0, { duration: 120, easing: ease });
        }),
    [disabled],
  );
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.1 * held.value }] }));
  return (
    <GestureDetector gesture={tap}>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        onAccessibilityTap={disabled ? undefined : onPress}
        // A little past its edge; less to the left, where the words are.
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
        testID={testID}
        // Dimmed while sending: it's ink, never glass (glass under a dimmed view isn't drawn).
        style={[style, { opacity: disabled ? 0.6 : 1 }]}
      >
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(120)}
          style={[slot, { backgroundColor: color.ink }]}
        >
          {children}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

/** A control inside the field. */
const slot = {
  width: SLOT,
  height: SLOT,
  borderRadius: 999,
  alignItems: "center",
  justifyContent: "center",
} as const;

/** The disc's five bars: their resting heights, which the voice level scales. */
const BARS = [8, 14, 20, 12, 7];

/**
 * At the field's leading edge in voice: listening, a yuzu disc whose bars
 * follow the microphone's level, each a beat behind the one before so they
 * ripple; tapped, it mutes, the disc goes quiet and shows the mic struck
 * through, and tapped again it listens. Refused the microphone, it's quiet
 * and does nothing.
 */
function ListenDisc({
  level,
  muted,
  blocked,
  listening,
  onPress,
}: {
  level: SharedValue<number>;
  muted: boolean;
  blocked: boolean;
  listening: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const live = !muted && !blocked;
  const smooth = useDerivedValue(() =>
    withTiming(live && listening ? level.value : 0, { duration: 120, easing: ease }),
  );
  // 0.9s a lap, each bar 0.13s behind the one before. Stopped while it can't hear, and
  // while the app is away: left running, it restyled the bars every frame for nothing.
  const clock = useSharedValue(0);
  const still = useReducedMotion();
  const awake = useAppActive();
  useEffect(() => {
    if (still || !live || !awake) return;
    // From 0: the repeat runs from the value it finds, and stopped near 1 every lap would be
    // a sliver of one.
    clock.value = 0;
    clock.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1);
    return () => cancelAnimation(clock);
  }, [still, live, awake]);
  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={muted ? "Unmute" : "Mute"}
      accessibilityState={{ disabled: blocked }}
      testID="mute"
      hitSlop={8}
      style={[slot, { backgroundColor: live ? brand.yuzu : color.chip }]}
    >
      {live ? (
        <View
          testID="waveform"
          style={{ flexDirection: "row", alignItems: "center", gap: 2, height: 22 }}
        >
          {BARS.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a fixed list; place is identity
            <Bar key={i} i={i} rest={h} level={smooth} clock={clock} />
          ))}
        </View>
      ) : (
        <MicOff size={17} color={blocked ? color.faint : color.ink} />
      )}
    </Pressable>
  );
}

function Bar({
  i,
  rest,
  level,
  clock,
}: {
  i: number;
  rest: number;
  level: SharedValue<number>;
  clock: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const phase = (clock.value + (i * 0.13) / 0.9) % 1;
    const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
    // Between 35% and 100% of its height; how far it moves follows the voice.
    const reach = 0.25 + 0.75 * level.value;
    return { transform: [{ scaleY: 0.35 + 0.65 * wave * reach }] };
  });
  return (
    <Animated.View
      style={[{ width: 3, height: rest, borderRadius: 2, backgroundColor: brand.ink }, style]}
    />
  );
}
