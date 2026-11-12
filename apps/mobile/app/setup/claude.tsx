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
} from "@ponzu/client/model/claude-entry";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { ClaudeTile, EntryCard, KeyTile } from "../../components/claude-entry";
import {
  Card,
  PillButton,
  RowButton,
  SetupRow,
  StepLayout,
  StepNote,
  TextButton,
} from "../../components/step";
import { backend } from "../../lib/cloud/backend";
import { useCloud } from "../../lib/cloud/query";
import { useSignOut } from "../../lib/cloud/use-sign-out";
import { CLAUDE, SETUP } from "../../lib/copy";
import { fail, tick } from "../../lib/haptics";

type KeyEntry = Extract<ClaudeCardState, { mode: "api_key" }>;
type Choosing = Extract<ClaudeCardState, { mode: "choose" }>;

/**
 * Connect Claude (onboarding 4.10, in the Mac's current words): required, since Claude Code
 * does the work. Two ways, each with its own button. Sign in starts a claude.ai sign-in, opens
 * it in Safari (as the board has it) and goes to the code screen (setup/code.tsx), where the
 * code claude.ai shows is pasted. Add key turns the card into a secure field for an Anthropic
 * API key. Once the API has the person's Claude, `me` says so and the gate goes on to the
 * canvases; a Claude connected on the Mac meanwhile does the same.
 */
export default function ConnectClaude() {
  const cloud = useCloud();
  const signOut = useSignOut();
  const [state, setState] = useState<Choosing | KeyEntry>(CHOOSING as Choosing);
  const [leaving, setLeaving] = useState(false);
  const start = useMutation(cloud.mutations.startClaudeSignIn());
  const connectKey = useMutation(cloud.mutations.connectApiKey());
  /** A start is on its way: presses wait for it, since each one is another sandbox. */
  const starting = useRef(false);
  const here = useRef(true);
  useEffect(
    () => () => {
      here.current = false;
    },
    [],
  );

  const signIn = () => {
    if (starting.current) return;
    starting.current = true;
    tick();
    setState({ mode: "choose", starting: true, failed: false });
    start
      .mutateAsync()
      .finally(() => {
        starting.current = false;
      })
      .then(
        ({ id, authorizeUrl, expiresAt }) => {
          // Left before it answered: the sign-in is let go of, as the Mac's card does.
          if (!here.current) {
            backend.api.claude.abandonSignIn(id).catch(() => {});
            return;
          }
          setState(CHOOSING as Choosing);
          // The code screen first, so it is there when the person comes back from Safari.
          router.push({ pathname: "/setup/code", params: { signIn: id, expiresAt } });
          void Linking.openURL(authorizeUrl).catch(() => {});
        },
        (error: unknown) => {
          fail();
          if (here.current) setState(afterStartFailed(CHOOSING, error) as Choosing);
        },
      );
  };

  const submitKey = (entry: KeyEntry) => {
    if (!canConnect(entry)) return;
    setState({ ...entry, status: "connecting" });
    // Once it is taken the gate moves on; until then the button stays on Connecting.
    connectKey.mutateAsync(entry.key).then(
      () => connectKey.reset(),
      (error: unknown) => {
        fail();
        if (here.current) setState(afterRefusal(entry, error) as KeyEntry);
      },
    );
  };

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    await signOut();
  };

  return (
    <StepLayout
      testID="setup-claude"
      progress={2}
      title={CLAUDE.title}
      body={CLAUDE.body}
      actions={
        <View style={{ gap: 6 }}>
          {state.mode === "api_key" ? (
            <PillButton
              testID="setup-claude-connect"
              label={CLAUDE.connect}
              disabled={!canConnect(state) && state.status !== "connecting"}
              busy={state.status === "connecting"}
              onPress={() => submitKey(state)}
            />
          ) : null}
          <TextButton
            testID="setup-sign-out"
            label={SETUP.signOut}
            disabled={leaving}
            onPress={() => void leave()}
          />
        </View>
      }
    >
      {state.mode === "api_key" ? (
        <EntryCard
          mode="api_key"
          value={state.key}
          connecting={state.status === "connecting"}
          error={entryError(state)}
          onChange={() => setState(CHOOSING as Choosing)}
          onInput={(text) => setState(afterInput(state, text) as KeyEntry)}
          onSubmit={() => submitKey(state)}
        />
      ) : (
        <Choose
          state={state}
          onSignIn={signIn}
          onAddKey={() => {
            tick();
            setState({ mode: "api_key", key: "", status: "idle" });
          }}
        />
      )}
    </StepLayout>
  );
}

function Choose({
  state,
  onSignIn,
  onAddKey,
}: {
  state: Choosing;
  onSignIn: () => void;
  onAddKey: () => void;
}) {
  return (
    <>
      <Card>
        <SetupRow
          testID="setup-claude-subscription"
          mark={<ClaudeTile />}
          title={CLAUDE.subscription}
          line={CLAUDE.subscriptionLine}
        >
          <RowButton
            testID="setup-claude-sign-in"
            tone="primary"
            label={`${CLAUDE.signIn} ↗`}
            accessibilityLabel={`${CLAUDE.signIn} to ${CLAUDE.subscription}`}
            busy={state.starting}
            onPress={onSignIn}
          />
        </SetupRow>
        <SetupRow
          testID="setup-claude-api-key"
          last
          mark={<KeyTile />}
          title={CLAUDE.apiKey}
          line={CLAUDE.apiKeyLine}
        >
          <RowButton
            testID="setup-claude-add-key"
            label={CLAUDE.addKey}
            accessibilityLabel={`${CLAUDE.addKey}: ${CLAUDE.apiKey}`}
            onPress={onAddKey}
          />
        </SetupRow>
      </Card>
      {state.failed || state.limited ? (
        <StepNote tone="danger" testID="setup-claude-failed">
          {state.limited ? CLAUDE_LIMITED : CLAUDE_UNREACHABLE}
        </StepNote>
      ) : null}
    </>
  );
}
