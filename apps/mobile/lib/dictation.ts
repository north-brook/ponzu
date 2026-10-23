import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSharedValue } from "react-native-reanimated";

/**
 * Dictation for a comment, on this iPhone only (`requiresOnDeviceRecognition`):
 * what's been said so far, the microphone's level for the waveform, and a
 * mute that pauses listening without leaving voice. Text already said before
 * a pause is kept; listening again adds to it.
 */
export function useDictation(active: boolean) {
  const [said, setSaid] = useState("");
  const [partial, setPartial] = useState("");
  const [muted, setMuted] = useState(false);
  const [state, setState] = useState<"idle" | "listening" | "denied" | "unavailable">("idle");
  /** 0 (silent) to 1, from the volume events, eased on the UI thread by the waveform. */
  const level = useSharedValue(0);
  const base = useRef("");

  const start = useCallback(async () => {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setState("unavailable");
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setState("denied");
      return;
    }
    const onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
    if (!onDevice) {
      // The design promises dictation stays on the phone; without an on-device model, don't send audio away.
      setState("unavailable");
      return;
    }
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: true,
      addsPunctuation: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 60 },
    });
  }, []);

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.abort();
    level.value = 0;
  }, []);

  useEffect(() => {
    if (active && !muted) start();
    else stop();
    return stop;
  }, [active, muted]);

  useSpeechRecognitionEvent("start", () => setState("listening"));
  useSpeechRecognitionEvent("end", () => {
    // Keep what was said; a new start adds to it.
    setSaid((s) => join(s, partialRef.current));
    setPartial("");
    partialRef.current = "";
    base.current = "";
    setState((st) => (st === "listening" ? "idle" : st));
  });
  const partialRef = useRef("");
  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results[0]?.transcript ?? "";
    if (e.isFinal) {
      setSaid((s) => join(s, text));
      setPartial("");
      partialRef.current = "";
    } else {
      setPartial(text);
      partialRef.current = text;
    }
  });
  useSpeechRecognitionEvent("volumechange", (e) => {
    // -2..10; below 0 is silence.
    level.value = Math.max(0, Math.min(1, e.value / 8));
  });
  useSpeechRecognitionEvent("error", (e) => {
    if (e.error === "not-allowed") setState("denied");
    else if (e.error === "language-not-supported" || e.error === "service-not-allowed")
      setState("unavailable");
  });

  const text = join(said, partial);
  return {
    text,
    setText: (t: string) => {
      setSaid(t);
      setPartial("");
      partialRef.current = "";
    },
    muted,
    setMuted,
    level,
    state,
  };
}

function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\s+$/, "")} ${b.replace(/^\s+/, "")}`;
}
