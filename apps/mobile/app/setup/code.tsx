import {
  afterInput,
  afterRefusal,
  afterStartFailed,
  type ClaudeEntry,
  canConnect,
  entryError,
  signInSpent,
} from "@ponzu/client/model/claude-entry";
import { useMutation } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { EntryCard } from "../../components/claude-entry";
import { PillButton, StepLayout, TextButton } from "../../components/step";
import { backend } from "../../lib/cloud/backend";
import { useCloud } from "../../lib/cloud/query";
import { useSignOut } from "../../lib/cloud/use-sign-out";
import { CLAUDE, SETUP } from "../../lib/copy";
import { fail, tick } from "../../lib/haptics";

type CodeEntry = Extract<ClaudeEntry, { mode: "subscription" }>;

/** A sign-in started and not yet finished: what the code goes to, and until when. */
interface PendingSignIn {
  id: string;
  expiresAt: string;
}

/**
 * Paste the code (onboarding 4.11): after approving on claude.ai in Safari, the person comes
 * back here with the code claude.ai shows. iOS's paste control at the field's edge pastes it
 * with one tap and no alert. Connect sends it; each way it can fail says so (the Mac's words),
 * and Open sign-in again starts a new sign-in. Change, or leaving, lets the sign-in go: each is
 * a sandbox the API runs until it is used or let go of.
 *
 * The sign-in comes in the route's params (`signIn`, `expiresAt`), from Connect Claude.
 */
export default function PasteCode() {
  const params = useLocalSearchParams<{ signIn?: string; expiresAt?: string }>();
  const cloud = useCloud();
  const signOut = useSignOut();
  const [pending, setPending] = useState<PendingSignIn | null>(
    params.signIn && params.expiresAt ? { id: params.signIn, expiresAt: params.expiresAt } : null,
  );
  const [state, setState] = useState<CodeEntry>({
    mode: "subscription",
    code: "",
    // Here without a sign-in (a link, a relaunch): only a new one helps.
    status: params.signIn && params.expiresAt ? "idle" : "expired",
  });
  const [leaving, setLeaving] = useState(false);
  const start = useMutation(cloud.mutations.startClaudeSignIn());
  const sendCode = useMutation(cloud.mutations.sendClaudeCode());
  /** The sign-in open at the API that this screen holds, until it is used or let go of. */
  const held = useRef<string | null>(pending?.id ?? null);
  /** Counts starts and leavings: only the answer to the latest start is taken. */
  const latest = useRef(0);
  const starting = useRef(false);

  const letGo = useCallback((id: string) => {
    // Nothing waits on it: if it doesn't arrive, the API's sweep ends the sign-in.
    backend.api.claude.abandonSignIn(id).catch(() => {});
  }, []);
  const leave = useCallback(() => {
    latest.current += 1;
    if (held.current) letGo(held.current);
    held.current = null;
  }, [letGo]);
  // Leaving the screen any way at all lets go of what it holds.
  useEffect(() => leave, [leave]);

  // Ten minutes after it began, a sign-in takes no code: say so before the person tries one.
  useEffect(() => {
    if (!pending) return;
    const left = Date.parse(pending.expiresAt) - Date.now();
    const timer = setTimeout(
      () =>
        setState((now) =>
          now.status === "connecting" ? now : { ...now, code: "", status: "expired" },
        ),
      Math.max(0, left),
    );
    return () => clearTimeout(timer);
  }, [pending]);

  const reopen = () => {
    if (starting.current) return;
    starting.current = true;
    tick();
    const ticket = ++latest.current;
    start
      .mutateAsync()
      .finally(() => {
        starting.current = false;
      })
      .then(
        ({ id, authorizeUrl, expiresAt }) => {
          if (ticket !== latest.current) return letGo(id);
          // The API has let the one before go: a new sign-in replaces it.
          held.current = id;
          setPending({ id, expiresAt });
          setState({ mode: "subscription", code: "", status: "idle" });
          void Linking.openURL(authorizeUrl).catch(() => {});
        },
        (error: unknown) => {
          fail();
          if (ticket === latest.current) setState(afterStartFailed(state, error) as CodeEntry);
        },
      );
  };

  const submit = () => {
    if (!canConnect(state)) return;
    const entry = state;
    if (!pending) {
      setState({ ...entry, code: "", status: "expired" });
      return;
    }
    setState({ ...entry, status: "connecting" });
    // A code on its way is the sign-in's to settle: taken, there is nothing left to let go of.
    const sending = held.current;
    held.current = null;
    const ticket = latest.current;
    sendCode.mutateAsync({ signInId: pending.id, code: entry.code.trim() }).then(
      // Claude is connected: `me` says so, and the gate goes on to the canvases. The screen
      // stays on Connecting until then, and keeps nothing of the code.
      () => sendCode.reset(),
      (error: unknown) => {
        fail();
        const next = afterRefusal(entry, error) as CodeEntry;
        if (ticket !== latest.current) {
          // Left since: a sign-in its code failed to use is let go of.
          if (sending && !signInSpent(next)) letGo(sending);
          return;
        }
        if (sending && !signInSpent(next)) held.current = sending;
        setState(next);
      },
    );
  };

  const change = () => {
    leave();
    if (router.canGoBack()) router.back();
    else router.replace("/setup/claude");
  };

  const quit = async () => {
    if (leaving) return;
    setLeaving(true);
    await signOut();
  };

  const connecting = state.status === "connecting";
  return (
    <StepLayout
      testID="setup-code"
      progress={2}
      title={CLAUDE.title}
      body={CLAUDE.body}
      actions={
        <View style={{ gap: 6 }}>
          <PillButton
            testID="setup-claude-connect"
            label={CLAUDE.connect}
            disabled={!canConnect(state) && !connecting}
            busy={connecting}
            onPress={submit}
          />
          <TextButton
            testID="setup-sign-out"
            label={SETUP.signOut}
            disabled={leaving}
            onPress={() => void quit()}
          />
        </View>
      }
    >
      <EntryCard
        mode="subscription"
        value={state.code}
        connecting={connecting}
        error={entryError(state)}
        onChange={change}
        onInput={(text) => setState((now) => afterInput(now, text) as CodeEntry)}
        onSubmit={submit}
        onReopen={reopen}
        reopening={start.isPending}
      />
    </StepLayout>
  );
}
