import type { Api } from "@ponzu/client";
import { nameFor } from "@ponzu/client/model/create";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BarButton } from "../components/chrome";
import { ConnectClaudeSheet } from "../components/connect-claude-sheet";
import { Back, Chevron, Close, Folder, Plus, Repo, Send, SliceMark } from "../components/icons";
import { ModelSheet } from "../components/model-sheet";
import { canvasPath } from "../lib/canvas/open";
import { backend } from "../lib/cloud/backend";
import {
  blockedOnSend,
  canSend,
  choiceKey,
  MODEL_CHOICE_KEY,
  type ModelChoice,
  modelChoice,
  projectName,
  readModelChoice,
  resetTime,
  sendFailure,
  statement,
  stillOffered,
} from "../lib/cloud/create";
import { currentDraft, keepDraft, pickedProject, useNewCanvasStore } from "../lib/cloud/new-canvas";
import { useCloud } from "../lib/cloud/query";
import { useProjects } from "../lib/cloud/use-projects";
import { CREATE, LIMITED, PICKER } from "../lib/copy";
import { fail, select, success, tick } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";

/** An image picked to go with the prompt, until there is a canvas to upload it to. */
interface Picked {
  id: string;
  uri: string;
  name: string;
  type: string;
}

/** A new create key: the API takes 8 to 64 of `A-Za-z0-9_-`, and a UUID is 36 of them. */
const newCreateKey = () => Crypto.randomUUID();

/**
 * New canvas (iPhone design §13), a full screen pushed over the list with only the glass back
 * button: the slice over the Mac's create page's statement, "Make something in <owner/name>"
 * or "Make something from scratch", whose project control opens the picker (pick-project.tsx).
 * At the foot, the composer: attach, the model and effort, and Send.
 *
 * Sending makes the canvas with its first message in one call, in the chosen repo or Scratch,
 * on the model and effort shown, and replaces this screen with it. Each composition carries one
 * create key, so a double tap or a retry makes one canvas. A prompt with images makes the
 * canvas first, uploads them, then says the message with them. What a send must wait for opens
 * over the screen with the prompt kept: a Claude not connected or signed out (the Claude card
 * as a sheet, and the prompt goes once it is connected), or a plan at its limit (Send then or
 * Cancel). A send that fails says why under the composer and keeps everything as it was.
 */
export default function NewCanvas() {
  const { color, shadow } = useTheme();
  const insets = useSafeAreaInsets();
  const cloud = useCloud();
  useNewCanvasStore();
  const { workspace, shelves } = useProjects();
  const workspaceId = workspace?.id ?? null;
  const me = useQuery({ ...cloud.queries.me(), enabled: cloud.userId !== null });
  const defaults = useQuery({ ...cloud.queries.claudeDefaults(), enabled: cloud.userId !== null });
  const create = useMutation(cloud.mutations.createCanvas());
  const [prompt, setPrompt] = useState(currentDraft);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [saved, setSaved] = useState<ModelChoice | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsClaude, setNeedsClaude] = useState(false);
  const [sendOnceConnected, setSendOnceConnected] = useState(false);
  const createKey = useRef(newCreateKey());
  /** The canvas this composition's key made, while its first message has yet to go. */
  const made = useRef<{ key: string; id: string } | null>(null);
  /**
   * The create key last sent without its message (the message was to follow with pictures).
   * Sent again, that key answers the canvas it may have made without making it again or saying
   * anything, so every later send with it says the message itself.
   */
  const bareKey = useRef<string | null>(null);
  const going = useRef(false);
  /** False once the screen has gone: a send that finishes later moves nothing then. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The last model and effort picked on this phone.
  useEffect(() => {
    let on = true;
    AsyncStorage.getItem(MODEL_CHOICE_KEY)
      .catch(() => null)
      .then((text) => {
        if (on) setSaved((now) => now ?? readModelChoice(text));
      });
    return () => {
      on = false;
    };
  }, []);

  // The prompt is kept as it is written, so leaving and coming back finds it.
  useEffect(() => keepDraft(prompt), [prompt]);

  const repos = shelves?.find((s) => s.workspaceId === workspaceId)?.repos ?? null;
  const project = workspaceId ? stillOffered(pickedProject(workspaceId), repos) : null;
  const choice = modelChoice(saved, defaults.data);
  // Another project is another canvas: a canvas made for the last one keeps what it has.
  const where = project && workspaceId ? choiceKey(project, workspaceId) : null;
  // A new key whether or not this screen heard back: a create whose answer was lost may still
  // have made a canvas in the last project, and its key would answer with that one.
  useEffect(() => {
    if (!where) return;
    made.current = null;
    createKey.current = newCreateKey();
  }, [where]);
  // Whether Claude stops a send is known once `me` has come, or couldn't be had (offline, when
  // the API answers the send for itself).
  const meKnown = me.data !== undefined || me.isError;
  const ready = workspaceId !== null && project !== null && meKnown && canSend(prompt, sending);
  const said = statement(project);

  const send = async (despiteLimit = false) => {
    const text = prompt.trim();
    if (!workspaceId || !project || !meKnown || !canSend(text, false) || going.current) return;
    const blocked = blockedOnSend(me.data, Date.now());
    if (blocked?.kind === "claude") {
      select();
      setNeedsClaude(true);
      setSendOnceConnected(true);
      return;
    }
    if (blocked?.kind === "limited" && !despiteLimit) {
      select();
      Alert.alert(LIMITED.title, LIMITED.line(resetTime(blocked.until, Date.now())), [
        { text: LIMITED.cancel, style: "cancel" },
        { text: LIMITED.sendThen, onPress: () => void send(true) },
      ]);
      return;
    }
    going.current = true;
    tick();
    setSending(true);
    setError(null);
    const images = picked;
    // This send's key, held for its whole life: whatever the screen's key becomes meanwhile,
    // the canvas this send makes is remembered under the key that made it.
    const key = createKey.current;
    try {
      // A send whose images or message didn't go made its canvas all the same: sent again, it
      // goes to that canvas, rather than ask the API for one its key already answers.
      const kept = made.current;
      const already = kept && kept.key === key ? kept.id : null;
      // With images, the message waits until they are files of the canvas; and so it does for
      // a key once sent that way, whose answer may be a canvas made before with nothing said.
      const bare = images.length > 0 || bareKey.current === key;
      if (bare) bareKey.current = key;
      const id =
        already ??
        (
          await create.mutateAsync({
            workspaceId,
            repoId: project.kind === "repo" ? project.repo.id : null,
            name: nameFor(text),
            // Without an answer about the defaults, the API starts the canvas on them itself.
            ...(choice ? { model: choice.model, effort: choice.effort } : {}),
            createKey: key,
            ...(bare ? {} : { message: { text } }),
          })
        ).id;
      made.current = { key, id };
      if (images.length) await sayWithImages(backend.api, id, text, images);
      else if (bare) await backend.api.canvases.sendMessage(id, { text, attachments: [] });
      made.current = null;
      if (createKey.current === key) createKey.current = newCreateKey();
      // The prompt it said is spent; a newer one written since (on a New canvas opened after
      // this one was left) is not.
      if (currentDraft().trim() === text) keepDraft("");
      if (!live.current) return;
      setPrompt("");
      setPicked([]);
      success();
      router.replace(canvasPath(id));
    } catch (failure) {
      if (!live.current) return;
      fail();
      setError(sendFailure(failure, made.current?.key === key));
    } finally {
      going.current = false;
      setSending(false);
    }
  };

  // Connected from the sheet: it closes, and the prompt it kept goes now.
  const claudeReady = blockedOnSend(me.data, Date.now())?.kind !== "claude";
  const latestSend = useRef(send);
  latestSend.current = send;
  useEffect(() => {
    if (!sendOnceConnected || !claudeReady) return;
    setSendOnceConnected(false);
    setNeedsClaude(false);
    void latestSend.current();
  }, [sendOnceConnected, claudeReady]);

  const attach = async () => {
    select();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 6,
      // JPEG rather than HEIC: what the API takes.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    }).catch(() => null);
    if (!result || result.canceled || !result.assets) return;
    const more = result.assets.map((asset, i): Picked => {
      const type = asset.mimeType ?? "image/jpeg";
      const name = asset.fileName ?? `image-${picked.length + i + 1}.jpg`;
      return {
        // Unique even when the same photo is attached twice, in one pick or two.
        id: `${asset.assetId ?? asset.uri}-${Crypto.randomUUID()}`,
        uri: asset.uri,
        // The library keeps a photo's own name ("IMG_0001.HEIC") on the JPEG it hands over: the
        // file goes up named for what it is, so the agent reads it as a JPEG.
        name: type === "image/jpeg" ? name.replace(/\.(heic|heif)$/i, ".jpg") : name,
        type,
      };
    });
    setPicked((now) => [...now, ...more]);
  };

  const back = () => {
    tick();
    if (router.canGoBack()) router.back();
    else router.replace("/canvases");
  };

  const blocked = blockedOnSend(me.data, Date.now());
  return (
    <View testID="new-canvas" style={{ flex: 1, backgroundColor: color.bg }}>
      <View style={{ position: "absolute", top: insets.top + 6, left: 16, zIndex: 2 }}>
        <BarButton testID="new-canvas-back" label={PICKER.back} onPress={back}>
          <Back color={color.ink} />
        </BarButton>
      </View>
      {/* The statement and the composer share what the keyboard leaves: the composer rides 8pt
          above it, and the statement, with its project control, stays in sight and in reach
          above the composer instead of under it. */}
      <KeyboardAvoidingView
        testID="new-canvas-keyboard"
        behavior="padding"
        keyboardVerticalOffset={8 - Math.max(insets.bottom, 12)}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            alignItems: "center",
            paddingTop: insets.top + 64,
            paddingBottom: 24,
            paddingHorizontal: 20,
            gap: 18,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <SliceMark size={44} color={color.ink} />
          <View style={{ alignItems: "center", gap: 4, maxWidth: "100%" }}>
            <Text
              accessibilityRole="header"
              accessibilityLabel={`${said.lead}${said.place ? ` ${said.place}` : ""}`}
              style={{
                fontFamily: "Funnel Display",
                fontWeight: "700",
                fontSize: 26,
                lineHeight: 32,
                letterSpacing: -0.03 * 26,
                color: color.ink,
                textAlign: "center",
              }}
            >
              {said.lead}
            </Text>
            <Pressable
              testID="new-canvas-project"
              accessibilityRole="button"
              accessibilityLabel={projectName(project, workspace?.name ?? null)}
              accessibilityHint={CREATE.chooseRepo}
              accessibilityState={{ busy: project === null, disabled: sending }}
              // A send on its way is for this project: another waits until it has gone.
              disabled={sending}
              onPress={() => {
                if (going.current) return;
                select();
                router.push("/pick-project");
              }}
              style={({ pressed }) => ({
                minHeight: 44,
                maxWidth: "100%",
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                borderRadius: 12,
                backgroundColor: pressed ? color.chip : "transparent",
              })}
            >
              {project === null ? (
                <View
                  style={{ width: 150, height: 18, borderRadius: 4, backgroundColor: color.chip }}
                />
              ) : (
                <>
                  {project.kind === "repo" ? (
                    <Repo color={color.muted} size={18} />
                  ) : (
                    <Folder color={color.muted} size={18} />
                  )}
                  <Text
                    numberOfLines={1}
                    style={{
                      flexShrink: 1,
                      fontFamily: "Funnel Display",
                      fontWeight: "700",
                      fontSize: 26,
                      lineHeight: 32,
                      letterSpacing: -0.03 * 26,
                      color: color.ink,
                    }}
                  >
                    {project.kind === "repo" ? (
                      <>
                        <Text style={{ color: color.faint }}>{`${project.repo.owner}/`}</Text>
                        {project.repo.name}
                      </>
                    ) : (
                      said.place
                    )}
                  </Text>
                </>
              )}
              <Chevron color={color.faint} size={16} />
            </Pressable>
          </View>
        </ScrollView>
        <View style={{ paddingHorizontal: 12, paddingBottom: Math.max(insets.bottom, 12) }}>
          {error ? (
            <Text
              testID="new-canvas-error"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{
                marginBottom: 8,
                paddingHorizontal: 8,
                fontFamily: "Inter",
                fontSize: 13,
                lineHeight: 18,
                color: color.danger,
              }}
            >
              {error}
            </Text>
          ) : null}
          <View
            testID="new-canvas-composer"
            style={{
              borderRadius: 26,
              backgroundColor: color.card,
              boxShadow: shadow.pop,
              padding: 8,
              gap: 4,
            }}
          >
            {picked.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, padding: 6 }}
              >
                {picked.map((image) => (
                  <View key={image.id}>
                    <Image
                      source={{ uri: image.uri }}
                      accessibilityIgnoresInvertColors
                      style={{ width: 56, height: 56, borderRadius: 10 }}
                    />
                    <Pressable
                      testID={`new-canvas-remove-${image.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={PICKER.remove(image.name)}
                      hitSlop={10}
                      onPress={() => setPicked((now) => now.filter((p) => p.id !== image.id))}
                      style={{
                        position: "absolute",
                        top: -6,
                        right: -6,
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        backgroundColor: color.ink,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Close color={color.bg} size={12} />
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            ) : null}
            <TextInput
              testID="new-canvas-prompt"
              accessibilityLabel={CREATE.placeholder}
              placeholder={CREATE.placeholder}
              placeholderTextColor={color.faint}
              value={prompt}
              onChangeText={(text) => {
                setPrompt(text);
                if (error) setError(null);
              }}
              multiline
              autoFocus
              editable={!sending}
              style={{
                minHeight: 44,
                maxHeight: 180,
                paddingHorizontal: 10,
                paddingTop: 10,
                paddingBottom: 6,
                fontFamily: "Inter",
                fontSize: 16,
                lineHeight: 22,
                color: color.ink,
              }}
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Pressable
                testID="new-canvas-attach"
                accessibilityRole="button"
                accessibilityLabel={CREATE.attach}
                onPress={() => void attach()}
                disabled={sending}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: color.chip,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Plus color={color.ink} />
              </Pressable>
              <View style={{ flex: 1 }} />
              {defaults.data && choice ? (
                <ModelSheet
                  models={defaults.data.models}
                  efforts={defaults.data.efforts}
                  model={choice.model}
                  effort={choice.effort}
                  onChange={(model, effort) => {
                    select();
                    const next = { model, effort };
                    setSaved(next);
                    void AsyncStorage.setItem(MODEL_CHOICE_KEY, JSON.stringify(next)).catch(
                      () => {},
                    );
                  }}
                />
              ) : null}
              <Pressable
                testID="new-canvas-send"
                accessibilityRole="button"
                accessibilityLabel={CREATE.send}
                accessibilityState={{ disabled: !ready, busy: sending }}
                disabled={!ready}
                onPress={() => void send()}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: ready || sending ? brand.yuzu : color.chip,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Send color={ready || sending ? brand.ink : color.faint} />
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
      <ConnectClaudeSheet
        visible={needsClaude}
        connected={blocked?.kind === "claude" ? blocked.connected : true}
        expired={blocked?.kind === "claude" ? blocked.expired : false}
        onDismiss={() => {
          setNeedsClaude(false);
          setSendOnceConnected(false);
        }}
      />
    </View>
  );
}

/** Uploads the images to the new canvas, then says the message with them. Throws on a failure. */
async function sayWithImages(
  api: Api,
  canvasId: string,
  text: string,
  images: readonly Picked[],
): Promise<void> {
  const uploaded = await Promise.all(
    images.map(async (image) =>
      api.canvases.upload(canvasId, {
        name: image.name,
        type: image.type,
        bytes: new Uint8Array(await new File(image.uri).arrayBuffer()),
      }),
    ),
  );
  const attachments = uploaded.flatMap((file) => (file.ref ? [file.ref] : []));
  await api.canvases.sendMessage(canvasId, { text, attachments });
}
