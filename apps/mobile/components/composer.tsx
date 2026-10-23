import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, type TextInputInstance, View } from "react-native";
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
import { useDictation } from "../lib/dictation";
import { useTheme } from "../lib/theme";
import { brand, EASE_OUT } from "../lib/tokens";
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

/**
 * Writing a comment or reply, by voice or typing (Flow › 6–9). One action
 * button: in voice, the keyboard (switch to typing) until something is said,
 * then send; in typing, the mic (switch to voice) until something is typed,
 * then send. Voice shows what's heard, a live waveform and a neutral mute.
 */
export function Composer({
  mode,
  onMode,
  placeholder,
  onSend,
  autoFocus = true,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  /** "Comment" or "Reply". */
  placeholder: string;
  onSend: (text: string, mode: Mode) => Promise<void> | void;
  /** Focus the field when typing starts. A thread's reply field waits for a tap. */
  autoFocus?: boolean;
}) {
  const { color } = useTheme();
  const dictation = useDictation(mode === "voice");
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<TextInputInstance>(null);
  const text = mode === "voice" ? dictation.text : typed;
  const has = text.trim().length > 0;

  const switchTo = (m: Mode) => {
    // What was said carries into typing, and back.
    if (m === "type") setTyped(dictation.text);
    else dictation.setText(typed);
    rememberMode(m);
    onMode(m);
  };
  const first = useRef(true);
  useEffect(() => {
    const was = first.current;
    first.current = false;
    if (mode === "type" && (autoFocus || !was)) setTimeout(() => input.current?.focus(), 60);
  }, [mode]);

  const send = async () => {
    if (!has || sending) return;
    setSending(true);
    try {
      await onSend(text.trim(), mode);
      setTyped("");
      dictation.setText("");
    } finally {
      setSending(false);
    }
  };

  const action = has ? (
    <RoundButton tone="ink" label="Send" onPress={send} disabled={sending} testID="send">
      <Send color={color.bg} />
    </RoundButton>
  ) : mode === "voice" ? (
    <RoundButton label="Type instead" onPress={() => switchTo("type")} testID="to-type">
      <Keyboard color={color.ink} />
    </RoundButton>
  ) : (
    <RoundButton label="Speak instead" onPress={() => switchTo("voice")} testID="to-voice">
      <Mic color={color.ink} />
    </RoundButton>
  );

  if (mode === "type")
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}
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
          testID="comment-input"
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 140,
            paddingTop: 11,
            paddingBottom: 11,
            paddingHorizontal: 14,
            borderRadius: 22,
            backgroundColor: color.canvas,
            fontFamily: "Inter",
            fontSize: 17,
            lineHeight: 22.95,
            color: color.ink,
          }}
        />
        {action}
      </Animated.View>
    );

  const quiet = dictation.state !== "listening" && !dictation.muted;
  const note =
    dictation.state === "denied"
      ? "Ponzu can't hear you. Turn on the microphone and speech recognition in Settings, or type."
      : dictation.state === "unavailable"
        ? "Dictation isn't available on this iPhone. Type instead."
        : null;
  return (
    <Animated.View entering={FadeIn.duration(250)} style={{ gap: 14 }}>
      <Text
        testID="transcript"
        style={{
          fontFamily: "Inter",
          fontSize: 19,
          lineHeight: 27.55,
          color: has ? color.ink : color.faint,
        }}
      >
        {has ? text : <Caret />}
        {has ? <Caret /> : (note ?? (dictation.muted ? "Muted" : "Listening…"))}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <RoundButton
          label={dictation.muted ? "Unmute" : "Mute"}
          onPress={() => dictation.setMuted(!dictation.muted)}
          testID="mute"
        >
          {dictation.muted ? <MicOff color={color.ink} /> : <Mic color={color.ink} />}
        </RoundButton>
        <Waveform level={dictation.level} active={has} quiet={quiet || dictation.muted} />
        {action}
      </View>
    </Animated.View>
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

/** A 44pt round button: chip (switch, mute) or ink (send). */
export function RoundButton({
  children,
  onPress,
  label,
  tone = "chip",
  disabled,
  testID,
}: {
  children: React.ReactNode;
  onPress: () => void;
  label: string;
  tone?: "chip" | "ink";
  disabled?: boolean;
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
        width: 44,
        height: 44,
        borderRadius: 999,
        backgroundColor: tone === "ink" ? color.ink : color.chip,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ scale: pressed ? 0.9 : 1 }],
        opacity: disabled ? 0.6 : 1,
      })}
    >
      <Animated.View key={label} entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

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
}: {
  level: SharedValue<number>;
  active: boolean;
  quiet: boolean;
}) {
  const { color } = useTheme();
  const smooth = useDerivedValue(() =>
    withTiming(quiet ? 0 : level.value, { duration: 120, easing: ease }),
  );
  // The design's wave: 0.9s, each bar 0.13s behind the one before.
  const clock = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    clock.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1);
    return () => cancelAnimation(clock);
  }, [still]);
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
