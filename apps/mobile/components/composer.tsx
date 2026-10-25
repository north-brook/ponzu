import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";
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
import { fail, select, success } from "../lib/haptics";
import { PARTS, phase, SWITCH_MS } from "../lib/morph";
import { useTheme } from "../lib/theme";
import { brand, EASE_OUT } from "../lib/tokens";
import { Glass } from "./glass";
import { Keyboard, Mic, MicOff, Send } from "./icons";

export type Mode = "voice" | "type";
/**
 * Unsent text, by what it's for (a new comment's pin, or a thread): kept
 * while the composer moves, as iPhone Duo folds and opens it from the sheet
 * to the panel or the half beside the design, and gone once it's sent.
 */
const drafts = new Map<string, string>();

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
/**
 * The comment field: lines of Inter 17 on a 22pt line, the padding that
 * centres one in the buttons' 44, and the tallest it grows (five lines)
 * before it scrolls.
 */
const FIELD_LINE = 22;
const FIELD_PAD = (44 - FIELD_LINE) / 2;
const FIELD_MAX = FIELD_PAD * 2 + FIELD_LINE * 5;

const styles = StyleSheet.create({
  field: {
    minHeight: 44,
    maxHeight: FIELD_MAX,
    paddingTop: FIELD_PAD,
    paddingBottom: FIELD_PAD,
    paddingHorizontal: 14,
    fontFamily: "Inter",
    fontSize: 17,
    lineHeight: FIELD_LINE,
  },
  fieldEmpty: { height: 44 },
  // Out of view, never faded: Liquid Glass draws as a plain view under a parent with opacity.
  hidden: { position: "absolute", left: -10_000, width: 300 },
});
/** Between "Listening…" (or what's said) and the row under it. */
const GAP = 14;

/**
 * Writing a comment or reply, by voice or typing (Flow › 6–9). One action
 * button: in voice, the keyboard (switch to typing) until something is said,
 * then send; in typing, the mic (switch to voice) until something is typed,
 * then send. Voice shows what's heard, a live waveform and a neutral mute.
 * The field and the waveform share one glass capsule, the buttons' height;
 * the field sizes itself, as iOS does a multiline text view, up to five lines.
 *
 * Switching is one sheet changing shape (Flow › 8 ⇄ 7), never two screens:
 * every part stays mounted and moves on one clock on the UI thread
 * (lib/morph.ts has the timing). The field steps out of view and the
 * waveform grows in its place, "Listening…" opens above, the mute slides in from the
 * left and the button's mic turns into the keyboard. The keyboard itself
 * drops or rises with the system's animation, and the sheet (sheet.tsx)
 * rides it.
 */
export function Composer({
  mode,
  onMode,
  placeholder,
  onSend,
  autoFocus = true,
  draft,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  /** "Comment" or "Reply". */
  placeholder: string;
  onSend: (text: string, mode: Mode) => Promise<void> | void;
  /** Focus the field when typing starts. A thread's reply field waits for a tap. */
  autoFocus?: boolean;
  /** What the unsent text is kept under (a pin's place, a thread's id) as the composer moves. */
  draft?: string;
}) {
  const { color } = useTheme();
  const voice = mode === "voice";
  const dictation = useDictation(voice);
  const [typed, setTypedState] = useState(() => (draft ? (drafts.get(draft) ?? "") : ""));
  const setTyped = (t: string) => {
    if (draft && t) drafts.set(draft, t);
    else if (draft) drafts.delete(draft);
    setTypedState(t);
  };
  const [sending, setSending] = useState(false);
  const input = useRef<TextInputInstance>(null);
  const text = voice ? dictation.text : typed;
  const has = text.trim().length > 0;

  /** 0 typing, 1 voice, and which way it's going. */
  const clock = useSharedValue(voice ? 1 : 0);
  const toVoice = useSharedValue(voice);
  const still = useReducedMotion();

  const switchTo = (m: Mode) => {
    select();
    // What was said carries into typing, and back.
    if (m === "type") setTyped(dictation.text);
    else {
      dictation.setText(typed);
      // The keyboard goes down with the system's own animation; the sheet follows it.
      KeyboardController.dismiss().catch(() => {});
    }
    rememberMode(m);
    onMode(m);
  };
  const first = useRef(true);
  useEffect(() => {
    const was = first.current;
    first.current = false;
    const to = voice ? 1 : 0;
    toVoice.value = voice;
    clock.value = still ? to : withTiming(to, { duration: SWITCH_MS, easing: Easing.linear });
    // The keyboard comes up as the field comes back, and the sheet rides it.
    if (!voice && (autoFocus || !was)) setTimeout(() => input.current?.focus(), was ? 60 : 0);
  }, [mode]);

  const send = async () => {
    if (!has || sending) return;
    setSending(true);
    try {
      await onSend(text.trim(), mode);
      success();
      setTyped("");
      dictation.setText("");
    } catch {
      // The screen says what went wrong; this says it didn't go.
      fail();
    } finally {
      setSending(false);
    }
  };

  // What's heard, or "Listening…", above the row: opens to its own height.
  const tall = useSharedValue(0);
  const onTranscript = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    tall.value = tall.value ? withTiming(h, { duration: 160, easing: ease }) : h;
  };
  const listenStyle = useAnimatedStyle(() => {
    const p = phase(clock.value, toVoice.value, PARTS.listen);
    return { height: tall.value * p, opacity: p, marginBottom: -GAP * (1 - p) };
  });
  const waveStyle = useAnimatedStyle(() => {
    const p = phase(clock.value, toVoice.value, PARTS.wave);
    return { opacity: p, transform: [{ scaleY: 0.2 + 0.8 * p }] };
  });
  const muteSlot = useAnimatedStyle(() => {
    const p = phase(clock.value, toVoice.value, PARTS.mute);
    return { width: 56 * p };
  });
  // The mute slides and grows in; its glass appears natively (never faded,
  // components/glass.tsx) and only its glyph fades.
  const muteStyle = useAnimatedStyle(() => {
    const p = phase(clock.value, toVoice.value, PARTS.mute);
    return { transform: [{ translateX: -16 * (1 - p) }, { scale: 0.6 + 0.4 * p }] };
  });
  const muteGlyph = useAnimatedStyle(() => ({
    opacity: phase(clock.value, toVoice.value, PARTS.mute),
  }));
  const middleStyle = useAnimatedStyle(() => ({
    marginRight: 8 + 4 * phase(clock.value, toVoice.value, PARTS.sheet),
  }));

  const quiet = dictation.state !== "listening" && !dictation.muted;
  const note =
    dictation.state === "denied"
      ? "Ponzu can't hear you. Turn on the microphone and speech recognition in Settings, or type."
      : dictation.state === "unavailable"
        ? "Dictation isn't available on this iPhone. Type instead."
        : null;
  const spoken = dictation.text.trim().length > 0;

  return (
    <View>
      <Animated.View
        style={[{ overflow: "hidden" }, listenStyle]}
        accessibilityElementsHidden={!voice}
        importantForAccessibility={voice ? "auto" : "no-hide-descendants"}
      >
        <View onLayout={onTranscript} style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
          <Text
            testID={voice ? "transcript" : undefined}
            style={{
              paddingHorizontal: 4,
              fontFamily: "Inter",
              fontSize: 19,
              lineHeight: 27.55,
              color: spoken ? color.ink : color.faint,
            }}
          >
            {spoken ? dictation.text : <Caret />}
            {spoken ? <Caret /> : (note ?? (dictation.muted ? "Muted" : "Listening…"))}
          </Text>
        </View>
      </Animated.View>
      <View style={{ marginTop: GAP, flexDirection: "row", alignItems: "flex-end" }}>
        <Animated.View
          style={[{ height: 44 }, muteSlot]}
          pointerEvents={voice ? "auto" : "none"}
          accessibilityElementsHidden={!voice}
          importantForAccessibility={voice ? "auto" : "no-hide-descendants"}
        >
          <Animated.View style={[{ position: "absolute", left: 0, top: 0 }, muteStyle]}>
            <RoundButton
              label={dictation.muted ? "Unmute" : "Mute"}
              onPress={() => dictation.setMuted(!dictation.muted)}
              shown={voice}
              testID="mute"
            >
              <Animated.View style={muteGlyph}>
                {dictation.muted ? <MicOff color={color.ink} /> : <Mic color={color.ink} />}
              </Animated.View>
            </RoundButton>
          </Animated.View>
        </Animated.View>
        <Animated.View style={[{ flex: 1, minWidth: 0, justifyContent: "center" }, middleStyle]}>
          {/* One glass capsule, the buttons' height and glass: the field in typing, the waveform in voice. */}
          <Glass
            testID="comment-field"
            style={{ minHeight: 44, borderRadius: 22, justifyContent: "flex-end" }}
          >
            {/*
              The field sizes itself, as iOS sizes a multiline text view: one line at 44, a
              line taller for each line of text up to FIELD_MAX, then it scrolls in itself
              and iOS keeps the line being typed in view. In voice it steps out of view (moved,
              never faded: glass breaks under opacity) and the waveform takes the row.
            */}
            <View
              style={voice ? styles.hidden : null}
              pointerEvents={voice ? "none" : "auto"}
              accessibilityElementsHidden={voice}
              importantForAccessibility={voice ? "no-hide-descendants" : "auto"}
            >
              <TextInput
                ref={input}
                value={typed}
                onChangeText={setTyped}
                placeholder={placeholder}
                placeholderTextColor={color.faint}
                selectionColor={brand.yuzu}
                cursorColor={brand.yuzu}
                multiline
                scrollEnabled
                editable={!voice}
                testID={voice ? undefined : "comment-input"}
                style={[
                  styles.field,
                  { color: color.ink },
                  // iOS keeps a multiline field's last height after it's emptied by a send:
                  // empty, it's one line (as augmenter's composer does).
                  (voice || typed === "") && styles.fieldEmpty,
                ]}
              />
            </View>
            <Animated.View
              pointerEvents="none"
              accessibilityElementsHidden={!voice}
              importantForAccessibility={voice ? "auto" : "no-hide-descendants"}
              style={[
                { position: "absolute", left: 4, right: 4, bottom: 4, height: 36 },
                waveStyle,
              ]}
            >
              <Waveform
                level={dictation.level}
                active={voice && spoken}
                quiet={!voice || quiet || dictation.muted}
                shown={voice && dictation.state !== "denied" && dictation.state !== "unavailable"}
              />
            </Animated.View>
          </Glass>
        </Animated.View>
        {has ? (
          <RoundButton tone="ink" label="Send" onPress={send} disabled={sending} testID="send">
            <Send color={color.bg} />
          </RoundButton>
        ) : (
          <SwitchButton
            voice={voice}
            clock={clock}
            toVoice={toVoice}
            onPress={() => switchTo(voice ? "type" : "voice")}
          />
        )}
      </View>
    </View>
  );
}

/**
 * The button that switches: the mic in typing, the keyboard in voice. Its
 * glyph turns over as the sheet changes, the mic rotating away as the
 * keyboard rotates in (Flow › 8 ⇄ 7).
 */
function SwitchButton({
  voice,
  clock,
  toVoice,
  onPress,
}: {
  voice: boolean;
  clock: SharedValue<number>;
  toVoice: SharedValue<boolean>;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const mic = useAnimatedStyle(() => {
    const p = phase(clock.value, toVoice.value, PARTS.mic);
    return { opacity: 1 - p, transform: [{ rotate: `${-90 * p}deg` }, { scale: 1 - 0.4 * p }] };
  });
  const keys = useAnimatedStyle(() => {
    const p = phase(clock.value, toVoice.value, PARTS.keys);
    return { opacity: p, transform: [{ rotate: `${90 * (1 - p)}deg` }, { scale: 0.6 + 0.4 * p }] };
  });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={voice ? "Type instead" : "Speak instead"}
      testID={voice ? "to-type" : "to-voice"}
    >
      <Glass interactive style={round}>
        <View style={{ width: 24, height: 24 }}>
          <Animated.View style={[centered, mic]}>
            <Mic color={color.ink} />
          </Animated.View>
          <Animated.View style={[centered, keys]}>
            <Keyboard color={color.ink} />
          </Animated.View>
        </View>
      </Glass>
    </Pressable>
  );
}

/** The yuzu caret, 2×22. */
function Caret() {
  return (
    <Text>
      <View
        style={{
          width: 2,
          height: 22,
          marginHorizontal: 2,
          backgroundColor: brand.yuzu,
          transform: [{ translateY: 4 }],
        }}
      />
    </Text>
  );
}

/**
 * A 44pt round button: glass (switch to typing or voice, mute) or ink (send).
 * The glass ones float on the sheet as the canvas bar's controls do.
 */
export function RoundButton({
  children,
  onPress,
  label,
  tone = "glass",
  disabled,
  shown = true,
  testID,
}: {
  children: React.ReactNode;
  onPress: () => void;
  label: string;
  tone?: "glass" | "ink";
  disabled?: boolean;
  /** Glass: there, or dissolved (components/glass.tsx). */
  shown?: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => ({
        transform: [{ scale: pressed && tone === "ink" ? 0.9 : 1 }],
        // Only the ink button dims: glass under a dimmed view isn't drawn.
        opacity: disabled && tone === "ink" ? 0.6 : 1,
      })}
    >
      {tone === "ink" ? (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(120)}
          style={[round, { backgroundColor: color.ink }]}
        >
          {children}
        </Animated.View>
      ) : (
        <Glass interactive shown={shown} style={round}>
          <Animated.View
            key={label}
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(120)}
          >
            {children}
          </Animated.View>
        </Glass>
      )}
    </Pressable>
  );
}

const round = {
  width: 44,
  height: 44,
  borderRadius: 999,
  alignItems: "center",
  justifyContent: "center",
} as const;

const centered = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  alignItems: "center",
  justifyContent: "center",
} as const;

/** The design's 34 bars: their resting heights, which the voice level scales. */
const BARS = [
  10, 18, 26, 14, 30, 22, 12, 24, 32, 16, 20, 28, 12, 18, 24, 10, 16, 22, 14, 8, 12, 20, 28, 16, 24,
  30, 18, 10, 22, 14, 26, 12, 18, 8,
];
/** While nothing's said, the quieter line the empty sheet shows. */
const IDLE = [
  4, 6, 8, 5, 10, 6, 4, 7, 9, 5, 6, 8, 4, 5, 7, 4, 5, 6, 5, 3, 4, 6, 8, 5, 7, 9, 5, 4, 6, 5, 7, 4,
  5, 3,
];

/**
 * The live waveform: bars that follow the microphone's level, each with its
 * own phase so the line ripples. Faint until there's text, then ink, as the
 * design's empty and speaking sheets show.
 */
function Waveform({
  level,
  active,
  quiet,
  shown,
}: {
  level: SharedValue<number>;
  active: boolean;
  quiet: boolean;
  /**
   * In voice, and able to hear. Typing, the waveform is out of sight; refused the microphone, it
   * has nothing to follow. Either way its clock stops and the line rests: left running, it
   * restyled all 34 bars on the UI thread every frame for as long as the sheet was open.
   */
  shown: boolean;
}) {
  const { color } = useTheme();
  const smooth = useDerivedValue(() =>
    withTiming(quiet ? 0 : level.value, { duration: 120, easing: ease }),
  );
  // The design's wave: 0.9s, each bar 0.13s behind the one before.
  const clock = useSharedValue(0);
  const still = useReducedMotion();
  const awake = useAppActive();
  useEffect(() => {
    if (still || !shown || !awake) return;
    clock.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1);
    return () => cancelAnimation(clock);
  }, [still, shown, awake]);
  return (
    <View
      testID="waveform"
      style={{
        flex: 1,
        minWidth: 0,
        height: 36,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
      }}
    >
      {BARS.map((h, i) => (
        <Bar
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a fixed list; place is identity
          key={i}
          i={i}
          rest={active ? h : IDLE[i]!}
          level={smooth}
          clock={clock}
          idle={!active}
          color={active ? color.ink : color.faint}
        />
      ))}
    </View>
  );
}

function Bar({
  i,
  rest,
  level,
  clock,
  idle,
  color,
}: {
  i: number;
  rest: number;
  level: SharedValue<number>;
  clock: SharedValue<number>;
  /** Nothing said yet: the faint line ripples on its own. */
  idle: boolean;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    const phase = (clock.value + (i * 0.13) / 0.9) % 1;
    const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
    // Between 30% and 100% of its height; how far it moves follows the voice.
    const reach = idle ? 1 : 0.2 + 0.8 * level.value;
    return { transform: [{ scaleY: 0.3 + 0.7 * wave * reach }] };
  });
  return (
    <Animated.View
      style={[
        {
          flex: 1,
          minWidth: 2,
          maxWidth: 3,
          height: rest,
          borderRadius: 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}
