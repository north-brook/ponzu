import { useSessionState } from "@ponzu/client/react";
import * as WebBrowser from "expo-web-browser";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Github, SliceMark } from "../components/icons";
import { backend } from "../lib/cloud/backend";
import { config } from "../lib/cloud/config";
import { expoCrypto } from "../lib/cloud/crypto";
import { signInNotice } from "../lib/cloud/gate";
import { signIn } from "../lib/cloud/sign-in";
import { fail } from "../lib/haptics";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";

/** The Mac's words (apps/studio/src/cloud/setup/sign-in.tsx), so both apps say the same. */
const TITLE = "Sign in to Ponzu";
const BODY = "Build on a canvas, steer with comments, and ship pull requests to your repos.";

/**
 * Sign in (onboarding 4.8): the mark, the title and one line, and Continue with GitHub pinned
 * at the bottom. The button opens the system's auth session (WorkOS, then GitHub) and the app
 * takes the redirect back; signing in moves the app on by itself (lib/cloud/use-gate.ts).
 * While the sheet is up the button shows the turning slice; it is not a Cancel, since the
 * sheet has its own. Closing the sheet comes back here with nothing said; a failure says one
 * line above the button.
 */
export default function SignIn() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const state = useSessionState(backend.session);
  const [opening, setOpening] = useState(false);
  // Signed in, the screen stays until `me` says where setup stands (lib/cloud/use-gate.ts):
  // the button keeps turning the slice until then, rather than offer to sign in again.
  const waiting = opening || state.status === "signed_in";
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useRef(false);
  const notice = failure ?? signInNotice(state);

  const go = async () => {
    if (busy.current || waiting) return;
    busy.current = true;
    setOpening(true);
    setFailure(null);
    const cfg = config();
    const fakeWithoutPage = backend.kind === "fake" && !backend.authorizeUrl;
    const outcome = await signIn({
      session: backend.session,
      workosClientId: cfg.workosClientId,
      scheme: cfg.scheme,
      crypto: expoCrypto,
      authorizeUrl: backend.authorizeUrl,
      openAuthSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
      ...(fakeWithoutPage ? { skipBrowser: { code: "fake" } } : {}),
    });
    busy.current = false;
    setOpening(false);
    if (outcome.kind === "failed") {
      fail();
      setFailure(outcome.message);
    }
  };

  return (
    <View testID="sign-in" style={{ flex: 1, backgroundColor: color.bg }}>
      <View style={{ position: "absolute", left: 32, right: 32, top: 250, alignItems: "center" }}>
        <SliceMark size={72} color={color.ink} />
        <Text
          accessibilityRole="header"
          style={{
            marginTop: 36,
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: 30,
            lineHeight: 33,
            letterSpacing: -0.02 * 30,
            color: color.ink,
            textAlign: "center",
          }}
        >
          {TITLE}
        </Text>
        <Text
          style={{
            marginTop: 12,
            fontFamily: "Inter",
            fontSize: 16,
            lineHeight: 24,
            color: color.muted,
            textAlign: "center",
          }}
        >
          {BODY}
        </Text>
      </View>
      <View
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          bottom: Math.max(58, insets.bottom + 24),
        }}
      >
        {notice && (
          <Text
            testID="sign-in-error"
            accessibilityLiveRegion="polite"
            style={{
              marginBottom: 12,
              fontFamily: "Inter",
              fontSize: 13,
              lineHeight: 18,
              color: color.danger,
              textAlign: "center",
            }}
          >
            {notice}
          </Text>
        )}
        <Pressable
          testID="sign-in-github"
          accessibilityRole="button"
          accessibilityLabel="Continue with GitHub"
          accessibilityState={{ busy: waiting }}
          onPress={() => void go()}
          style={({ pressed }) => ({
            height: 54,
            borderRadius: 99,
            backgroundColor: "#141414",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            opacity: pressed && !waiting ? 0.8 : 1,
          })}
        >
          {waiting ? (
            <View testID="sign-in-waiting">
              <Juice size={20} color="#a9a59b" />
            </View>
          ) : (
            <Github size={20} color="#ffffff" />
          )}
          <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 17, color: "#ffffff" }}>
            Continue with GitHub
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
