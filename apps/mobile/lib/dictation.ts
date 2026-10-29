import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { Listener, type ListenState } from "./listen";

/**
 * Dictation for a comment, on this iPhone only (`requiresOnDeviceRecognition`):
 * what's been said so far, the microphone's level for the waveform, and a
 * mute that pauses listening without leaving voice. Text already said before
 * a pause is kept; listening again adds to it.
 */
export function useDictation(active: boolean, initial = "") {
  const [said, setSaid] = useState(initial);
  const [partial, setPartial] = useState("");
  const [muted, setMuted] = useState(false);
  const [state, setState] = useState<ListenState>("idle");
  /** 0 (silent) to 1, from the volume events, eased on the UI thread by the waveform. */
  const level = useSharedValue(0);
  const base = useRef("");

  // One listener for the sheet's life: its starts and stops survive the
  // re-renders the permission prompts cause (lib/listen.ts).
  const listener = useRef<Listener | null>(null);
  listener.current ??= new Listener(
    {
      available: () => ExpoSpeechRecognitionModule.isRecognitionAvailable(),
      requestPermissions: () => ExpoSpeechRecognitionModule.requestPermissionsAsync(),
      onDevice: () => ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
      start: () =>
        ExpoSpeechRecognitionModule.start({
          lang: "en-US",
          interimResults: true,
          continuous: true,
          requiresOnDeviceRecognition: true,
          addsPunctuation: true,
          volumeChangeEventOptions: { enabled: true, intervalMillis: 60 },
        }),
      abort: () => ExpoSpeechRecognitionModule.abort(),
    },
    setState,
    // Development: Metro's log says when the recognizer starts, for checking the first use.
    __DEV__ ? (msg) => console.log(`[dictation] ${msg}`) : undefined,
  );

  useEffect(() => {
    const l = listener.current!;
    if (active && !muted) l.start();
    else {
      l.stop();
      level.value = 0;
    }
    return () => {
      l.stop();
      level.value = 0;
    };
  }, [active, muted]);
  // Back from the permission prompts (or anything else over the app): listen if still asked to.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") listener.current!.resumed();
    });
    return () => sub.remove();
  }, []);

  useSpeechRecognitionEvent("start", () => setState("listening"));
  useSpeechRecognitionEvent("end", () => {
    listener.current!.ended();
    // Keep what was said; a new start adds to it. The words are read now: the updater can run
    // after the ref is cleared below.
    const heard = partialRef.current;
    setSaid((s) => join(s, heard));
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
