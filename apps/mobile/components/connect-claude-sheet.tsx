import {
  afterInput,
  afterRefusal,
  afterStartFailed,
  CHOOSING,
  CLAUDE_LIMITED,
  CLAUDE_UNREACHABLE,
  type ClaudeCardState,
  canConnect,
  entryError,
  signInSpent,
} from "@ponzu/client/model/claude-entry";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Linking, Modal, ScrollView, Text, View } from "react-native";
import { backend } from "../lib/cloud/backend";
import { useCloud } from "../lib/cloud/query";
import { BLOCKED, CLAUDE } from "../lib/copy";
import { fail, tick } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { ClaudeTile, EntryCard, KeyTile } from "./claude-entry";
import { Card, PillButton, RowButton, SetupRow, StepNote, TextButton } from "./step";

/** A claude.ai sign-in started here and not yet used: what its code goes to, and until when. */
interface Pending {
  id: string;
  expiresAt: string;
}

/**
 * A send that needs the person's Claude first, as a sheet over New canvas: the Mac's dialog for
 * the same moment (its title and words by whether Claude was never connected, ran out or was
 * signed out), holding the Claude card. Sign in opens claude.ai in Safari and the card becomes
 * the code's field, with iOS's paste control; Add key, a secure field. Once `me` says Claude is
 * connected the screen under it closes the sheet and sends the prompt it kept. Cancel, or
 * closing it, lets go of a sign-in it started, as the setup screens do.
 */
export function ConnectClaudeSheet({
  visible,
  connected,
  expired,
  onDismiss,
}: {
  visible: boolean;
  /** False for someone with no Claude at all. */
  connected: boolean;
  /** Its sign-in ran out, rather than being signed out. */
  expired: boolean;
  onDismiss: () => void;
}) {
  const { color } = useTheme();
  const cloud = useCloud();
  const [state, setState] = useState<ClaudeCardState>(CHOOSING);
  const [pending, setPending] = useState<Pending | null>(null);
  const start = useMutation(cloud.mutations.startClaudeSignIn());
  const connectKey = useMutation(cloud.mutations.connectApiKey());
  const sendCode = useMutation(cloud.mutations.sendClaudeCode());
  /** The sign-in this sheet holds at the API, until it is used or let go of. */
  const held = useRef<string | null>(null);
  /** Counts starts and partings: only the answer to the latest start is taken. */
  const latest = useRef(0);
  const starting = useRef(false);

  const letGo = () => {
    latest.current += 1;
    const id = held.current;
    held.current = null;
    // Nothing waits on it: if it doesn't arrive, the API's sweep ends the sign-in.
    if (id) backend.api.claude.abandonSignIn(id).catch(() => {});
  };
  const letGoRef = useRef(letGo);
  letGoRef.current = letGo;
  // Closed or gone, the sheet lets go of what it holds and starts again from the two ways.
  useEffect(() => {
    if (visible) return;
    letGoRef.current();
    setState(CHOOSING);
    setPending(null);
  }, [visible]);
  useEffect(() => () => letGoRef.current(), []);

  const signIn = () => {
    if (starting.current) return;
    starting.current = true;
    tick();
    const from = state;
    if (from.mode === "choose") setState({ ...from, starting: true, failed: false });
    const ticket = ++latest.current;
    start
      .mutateAsync()
      .finally(() => {
        starting.current = false;
      })
      .then(
        ({ id, authorizeUrl, expiresAt }) => {
          if (ticket !== latest.current) {
            backend.api.claude.abandonSignIn(id).catch(() => {});
            return;
          }
          held.current = id;
          setPending({ id, expiresAt });
          setState({ mode: "subscription", code: "", status: "idle" });
          void Linking.openURL(authorizeUrl).catch(() => {});
        },
        (error: unknown) => {
          fail();
          if (ticket === latest.current) setState(afterStartFailed(from, error));
        },
      );
  };

  const submit = () => {
    if (!canConnect(state) || state.mode === "choose") return;
    const entry = state;
    setState({ ...entry, status: "connecting" } as ClaudeCardState);
    const ticket = latest.current;
    const refused = (error: unknown) => {
      fail();
      if (ticket === latest.current) setState(afterRefusal(entry, error));
    };
    if (entry.mode === "api_key") {
      // Taken, `me` says Claude is connected and the screen under the sheet sends.
      connectKey.mutateAsync(entry.key).then(() => connectKey.reset(), refused);
      return;
    }
    if (!pending) {
      setState({ ...entry, code: "", status: "expired" });
      return;
    }
    const sending = held.current;
    held.current = null;
    sendCode.mutateAsync({ signInId: pending.id, code: entry.code.trim() }).then(
      () => sendCode.reset(),
      (error: unknown) => {
        const next = afterRefusal(entry, error);
        // A sign-in its code didn't use is still this sheet's to let go of.
        if (sending && !signInSpent(next)) held.current = sending;
        refused(error);
      },
    );
  };

  const title = !connected ? BLOCKED.connect : expired ? BLOCKED.expired : BLOCKED.signedOut;
  const body = connected
    ? `${expired ? BLOCKED.expiredBody : BLOCKED.signedOutBody} ${BLOCKED.andSend}`
    : `${BLOCKED.connectBody} ${BLOCKED.andSend}`;
  const connecting = state.mode !== "choose" && state.status === "connecting";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onDismiss}
    >
      <ScrollView
        testID="connect-claude-sheet"
        style={{ flex: 1, backgroundColor: color.bg }}
        contentContainerStyle={{ padding: 20, paddingTop: 28, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: 24,
            lineHeight: 28,
            color: color.ink,
          }}
        >
          {title}
        </Text>
        <Text style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 21, color: color.muted }}>
          {body}
        </Text>
        {state.mode === "choose" ? (
          <>
            <Card>
              <SetupRow
                testID="connect-claude-subscription"
                mark={<ClaudeTile />}
                title={CLAUDE.subscription}
                line={CLAUDE.subscriptionLine}
              >
                <RowButton
                  testID="connect-claude-sign-in"
                  tone="primary"
                  label={`${CLAUDE.signIn} ↗`}
                  accessibilityLabel={`${CLAUDE.signIn} to ${CLAUDE.subscription}`}
                  busy={state.starting}
                  onPress={signIn}
                />
              </SetupRow>
              <SetupRow
                testID="connect-claude-api-key"
                last
                mark={<KeyTile />}
                title={CLAUDE.apiKey}
                line={CLAUDE.apiKeyLine}
              >
                <RowButton
                  testID="connect-claude-add-key"
                  label={CLAUDE.addKey}
                  accessibilityLabel={`${CLAUDE.addKey}: ${CLAUDE.apiKey}`}
                  onPress={() => {
                    tick();
                    setState({ mode: "api_key", key: "", status: "idle" });
                  }}
                />
              </SetupRow>
            </Card>
            {state.failed || state.limited ? (
              <StepNote tone="danger" testID="connect-claude-failed">
                {state.limited ? CLAUDE_LIMITED : CLAUDE_UNREACHABLE}
              </StepNote>
            ) : null}
          </>
        ) : (
          <EntryCard
            mode={state.mode}
            value={state.mode === "subscription" ? state.code : state.key}
            connecting={connecting}
            error={entryError(state)}
            onChange={() => {
              letGo();
              setPending(null);
              setState(CHOOSING);
            }}
            onInput={(text) =>
              setState((now) => (now.mode === "choose" ? now : afterInput(now, text)))
            }
            onSubmit={submit}
            {...(state.mode === "subscription"
              ? { onReopen: signIn, reopening: start.isPending }
              : {})}
          />
        )}
        <View style={{ gap: 6, marginTop: 6 }}>
          {state.mode === "choose" ? null : (
            <PillButton
              testID="connect-claude-connect"
              label={BLOCKED.connectAndSend}
              disabled={!canConnect(state) && !connecting}
              busy={connecting}
              onPress={submit}
            />
          )}
          <TextButton testID="connect-claude-cancel" label={BLOCKED.cancel} onPress={onDismiss} />
        </View>
      </ScrollView>
    </Modal>
  );
}
