import { type Api, ApiError } from "@ponzu/client";
import { nameFor } from "@ponzu/client/model/create";
import { useRepoIdeas } from "@ponzu/client/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ProjectChoice, RepoShelf } from "../cloud/create/create.ts";
import { CreatePage } from "../cloud/create/create-page.tsx";
import { type FlightOrigin, takeOff } from "../cloud/create/flight.ts";
import { ClaudeSignedOutDialog } from "../cloud/dialogs/account-dialogs.tsx";
import {
  type Attachment,
  type Effort,
  effortsOf,
  type PendingAttachment,
  type Repo,
} from "../cloud/model.ts";
import { useAnalytics } from "./analytics/provider.tsx";
import type { BillingWall, Held } from "./billing/wall.ts";
import { useBillingWall } from "./billing/wall.tsx";
import type { FreshCanvas } from "./canvas.tsx";
import type { Host } from "./host.ts";
import { Banner } from "./notices.tsx";
import { usePonzu } from "./ponzu-query.tsx";
import { useClaudeConnect } from "./setup/claude-connect.ts";

/*
 * Fresh start: the create page, made real. Sending makes the canvas with its first message in
 * one call (POST /v1/canvases), on the model and effort the picker shows (the last ones picked
 * here, on this Mac, or else the person's defaults), in the chosen repo or Scratch, and opens it. Each composition carries
 * a create key, so sending it twice makes one canvas. A prompt with images makes the canvas
 * first, uploads them to it, then says the message with them.
 *
 * What a send needs first opens over the window with the prompt kept, and the prompt goes once
 * it is done: a Claude not connected, or signed out. While billing is on, a send past the
 * workspace's free credits or cap, or with a payment past due, is turned down with nothing made
 * (402 `billing_required`): the billing wall opens with the prompt kept here, and sends it again,
 * with the same create key, once the card is added, the cap raised or the invoice paid.
 */

/** How long the pictures sent with a first message are kept for its bubble, in ms. */
const PREVIEWS_KEPT_MS = 60_000;

/** What a canvas is called until the agent names it: the rule the phone shares. */
export { nameFor };

/** A new create key: the API takes 8 to 64 of `A-Za-z0-9_-`. */
export function newCreateKey(): string {
  return crypto.randomUUID();
}

type Me = Awaited<ReturnType<Api["me"]>>;

/** Whether a send can go now, or must connect the person's Claude first. */
export function claudeReady(me: Pick<Me, "claudeAccount"> | undefined): boolean {
  return me?.claudeAccount?.status === "connected";
}

/** An image picked to go with the prompt, held here until there is a canvas to upload it to. */
interface Picked extends PendingAttachment {
  file: File;
}

/**
 * The create page as it was when Scratch or a repo in another workspace was chosen: the window
 * switches to that workspace (a new `WorkspaceWindow`, so a new create page) and hands this over,
 * so the page there opens with that project chosen and the words, images and picked idea as they
 * were.
 */
export interface CreateHandoff {
  workspaceId: string;
  project: ProjectChoice;
  prompt: string;
  picked: Picked[];
  idea: string | null;
}

/**
 * A send, the moment it goes: what the canvas's view shows while the API makes it (its first
 * line, its name), and where the composer was, to travel from (cloud/create/landing.ts).
 */
export interface Launch {
  key: string;
  text: string;
  name: string;
  attachments: Attachment[];
  origin: FlightOrigin | null;
}

export function CreateView({
  host,
  workspaceId,
  workspaceName,
  repos,
  elsewhere,
  handoff,
  onHandoffTaken,
  onSwitchWorkspace,
  showIdeas,
  onLaunch,
  onLaunchFailed,
  onCreated,
  onFirstMessageDropped,
  onAllowMore,
}: {
  host: Host;
  workspaceId: string;
  /** As the sidebar names it: the picker's heading, and whose Scratch the selector says. */
  workspaceName: string;
  /** Repos the person can push to; null while they load. */
  repos: Repo[] | null;
  /** Each other usable workspace, with the repos the person can push to once they arrive. */
  elsewhere: RepoShelf[];
  /** What the create page in the workspace this window just left handed over, if anything. */
  handoff: CreateHandoff | null;
  onHandoffTaken: () => void;
  /** Scratch or a repo in another workspace was chosen: switch to it, carrying the page over. */
  onSwitchWorkspace: (handoff: CreateHandoff) => void;
  /** Ideas show while the person is new to the workspace. */
  showIdeas: boolean;
  /** A send went: the canvas's view comes at once, without waiting on the API. */
  onLaunch: (launch: Launch) => void;
  /** The send came to nothing: the create page again, as it was, with the error said. */
  onLaunchFailed: () => void;
  /**
   * The canvas is made: open it, with what its answer said, so it opens on its first message.
   * `messageFailed` when the first message didn't go.
   */
  onCreated: (canvas: FreshCanvas, messageFailed: boolean) => void;
  /**
   * A first message sent after its images and held at the billing wall came to nothing after
   * all: the wall was dismissed, or the send failed once the limit lifted. Told as
   * `messageFailed` is, since the prompt has already left the page.
   */
  onFirstMessageDropped?: () => void;
  onAllowMore: () => void;
}) {
  const { queries, mutations } = usePonzu();
  const me = useQuery(queries.me());
  const defaults = useQuery(queries.claudeDefaults());
  const create = useMutation(mutations.createCanvas());
  const wall = useBillingWall();
  // Handed over by the page in the workspace just left, or fresh.
  const [taken] = useState(() => (handoff?.workspaceId === workspaceId ? handoff : null));
  const [prompt, setPrompt] = useState(taken?.prompt ?? "");
  const [chosen, setChosen] = useState<ProjectChoice | null>(taken?.project ?? null);
  const [model, setModel] = useState<Choice | null>(loadChoice);
  const [picked, setPicked] = useState<Picked[]>(taken?.picked ?? []);
  const [sending, setSending] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsClaude, setNeedsClaude] = useState(false);
  const [sendOnceConnected, setSendOnceConnected] = useState(false);
  const createKey = useRef(newCreateKey());
  const going = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const analytics = useAnalytics();
  /** The idea last picked into the composer, to tell an idea sent from words of their own. */
  const pickedIdea = useRef<string | null>(taken?.idea ?? null);
  // Until the person picks, the repo pushed to last, or Scratch when there is none; nothing
  // while the repos load, so the selector never says Scratch before it knows.
  const shown: ProjectChoice | null =
    chosen ??
    (repos === null ? null : repos[0] ? { kind: "repo", repo: repos[0] } : { kind: "scratch" });
  // A canvas sent before the repos are known is made in Scratch, as the API would.
  const project: ProjectChoice = shown ?? { kind: "scratch" };
  const ideas = useRepoIdeas(
    host.api,
    showIdeas && project.kind === "repo" ? project.repo.id : null,
  );
  useEffect(() => {
    if (taken) onHandoffTaken();
  }, [taken, onHandoffTaken]);
  /** Set once the page's images have been handed to the next workspace's page, to keep them. */
  const handedOver = useRef(false);
  // The last choice holds while the account still offers it (a model that takes no effort
  // carries one all the same, which the API lets by).
  const takes =
    model && defaults.data
      ? effortsOf(defaults.data.models, defaults.data.efforts, model.model)
      : null;
  const remembered =
    model &&
    takes &&
    defaults.data?.models.some((m) => m.id === model.model) &&
    (takes.length === 0 || takes.includes(model.effort))
      ? model
      : null;
  const choice =
    remembered ??
    (defaults.data ? { model: defaults.data.model, effort: defaults.data.effort } : null);
  const ready = claudeReady(me.data);

  const connect = useClaudeConnect({
    openExternal: host.openExternal,
    onConnected: () => {
      setNeedsClaude(false);
      setSendOnceConnected(true);
    },
  });

  // The pictures picked are let go of when they are taken out, sent, or the page goes.
  const held = useRef(picked);
  held.current = picked;
  useEffect(
    () => () => {
      if (!handedOver.current) release(held.current);
    },
    [],
  );

  const send = async () => {
    const text = prompt.trim();
    if (!text || going.current) return;
    if (!ready) {
      setNeedsClaude(true);
      return;
    }
    going.current = true;
    setSending(true);
    setError(null);
    const images = picked;
    // The canvas's view, now: the composer travels from where it is to the thread.
    const shown = images.map(
      ({ name, previewUrl, file }): Attachment => ({
        ref: `assets/${name}`,
        url: previewUrl,
        contentType: file.type,
      }),
    );
    onLaunch({
      key: createKey.current,
      text,
      name: nameFor(text),
      attachments: shown,
      origin: takeOff(document.querySelector("[data-create-dock]")),
    });
    setLaunched(true);
    try {
      const canvas = await create.mutateAsync({
        workspaceId,
        repoId: project.kind === "repo" ? project.repo.id : null,
        name: nameFor(text),
        // Without an answer about the defaults, the API starts the canvas on them itself.
        ...(choice ? { model: choice.model, effort: choice.effort } : {}),
        createKey: createKey.current,
        // With images, the message waits until they are files of the canvas.
        ...(images.length ? {} : { message: { text } }),
      });
      const idea = pickedIdea.current;
      analytics.capture("create prompt sent", {
        source: idea === null ? "typed" : idea.trim() === text ? "idea" : "idea_edited",
        project: project.kind,
        images: images.length,
      });
      pickedIdea.current = null;
      const said = images.length
        ? await sayWithImages(host.api, canvas.id, text, images, wall, () =>
            onFirstMessageDropped?.(),
          )
        : true;
      createKey.current = newCreateKey();
      setPrompt("");
      // The thread shows them until it has the canvas's own copies.
      setTimeout(() => release(images), PREVIEWS_KEPT_MS);
      handedOver.current = true;
      setPicked([]);
      onCreated(
        {
          id: canvas.id,
          name: canvas.name,
          message: said ? text : null,
          attachments: shown,
          access: canvas.access,
          head: {
            agentState: canvas.agentState,
            agentStatus: canvas.agentStatus,
            agentBlocker: canvas.agentBlocker,
          },
        },
        // Held at the billing wall, it isn't lost: it goes once the limit lifts.
        said === false,
      );
    } catch (failure) {
      // Back to the page as it was: the words, the images, the project; nothing travels back.
      // The page gives the caret back to the field as it shows it again (create-page.tsx).
      setLaunched(false);
      onLaunchFailed();
      // At a billing limit nothing was made: the wall holds the prompt, and sends it again with
      // the same create key once the limit lifts.
      if (wall?.refused(failure, { kind: "create", run: () => latestSend.current() })) return;
      analytics.capture("notice shown", { notice: "canvas_not_made" });
      setError(
        failure instanceof ApiError && failure.code === "network"
          ? "Ponzu can't be reached. Check your connection and send it again."
          : failure instanceof ApiError && failure.code === "model_not_offered"
            ? // The defaults are read again (mutations.ts), so the picker shows what is offered.
              "Your Claude account doesn't offer that model any more. Check the model and send it again."
            : "That canvas couldn't be made. Try again.",
      );
    } finally {
      going.current = false;
      setSending(false);
    }
  };

  // Connected from the dialog: the prompt it kept goes now.
  const latestSend = useRef(send);
  latestSend.current = send;
  useEffect(() => {
    if (!sendOnceConnected || !ready) return;
    setSendOnceConnected(false);
    void latestSend.current();
  }, [sendOnceConnected, ready]);

  return (
    <>
      <CreatePage
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={() => void send()}
        onAttach={() => picker.current?.click()}
        sending={sending}
        launched={launched}
        model={
          defaults.data && choice
            ? {
                models: defaults.data.models,
                efforts: defaults.data.efforts,
                model: choice.model,
                effort: choice.effort,
                onChange: (id, effort) => {
                  setModel({ model: id, effort });
                  saveChoice({ model: id, effort });
                },
              }
            : null
        }
        project={shown}
        workspaceName={workspaceName}
        repos={repos}
        elsewhere={elsewhere}
        onProjectChange={(choice, there) => {
          if (!there || there === workspaceId) return setChosen(choice);
          handedOver.current = true;
          onSwitchWorkspace({
            workspaceId: there,
            project: choice,
            prompt,
            picked,
            idea: pickedIdea.current,
          });
        }}
        onAllowMore={onAllowMore}
        ideas={ideas}
        onIdeaPicked={(idea, position) => {
          pickedIdea.current = idea.prompt;
          analytics.capture("idea chosen", { position });
        }}
        attachments={picked}
        onRemoveAttachment={(id) => {
          release(picked.filter((p) => p.id === id));
          setPicked(picked.filter((p) => p.id !== id));
        }}
      />
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])].filter((file) =>
            file.type.startsWith("image/"),
          );
          e.currentTarget.value = "";
          setPicked((now) => [...now, ...files.map(toPicked)]);
        }}
      />
      <ClaudeSignedOutDialog
        open={needsClaude}
        onDismiss={() => {
          // Closing the dialog leaves its sign-in, if one was started: it is let go of.
          connect.onChange();
          setNeedsClaude(false);
          setSendOnceConnected(false);
        }}
        card={connect}
        connected={me.data?.claudeAccount != null}
        expired={me.data?.claudeAccount?.status === "expired"}
      />
      {error ? <Banner>{error}</Banner> : null}
    </>
  );
}

type Choice = { model: string; effort: Effort };

/** Where the last model and effort picked here are kept, so the next canvas starts on them. */
const CHOICE_KEY = "ponzu.create.model";

function loadChoice(): Choice | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "null") as Partial<Choice> | null;
    return typeof saved?.model === "string" && typeof saved.effort === "string"
      ? { model: saved.model, effort: saved.effort as Effort }
      : null;
  } catch {
    return null;
  }
}

function saveChoice(choice: Choice): void {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // Without storage, the choice holds while the page is open.
  }
}

function toPicked(file: File): Picked {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    previewUrl: URL.createObjectURL(file),
    status: "ready",
    file,
  };
}

function release(images: Picked[]) {
  for (const image of images) URL.revokeObjectURL(image.previewUrl);
}

/**
 * Uploads the images to the new canvas, then says the message with them. True once said; false
 * when it wasn't, unless the billing wall held the message to send once its limit lifts (null).
 * A held message that comes to nothing after all (the wall dismissed, or the send failing once
 * the limit lifted) calls `dropped`, so the person is told as they would have been at once.
 */
async function sayWithImages(
  api: Api,
  canvasId: string,
  text: string,
  images: Picked[],
  wall: BillingWall | null,
  dropped: () => void,
): Promise<boolean | null> {
  let attachments: string[] | null = null;
  try {
    const uploaded = await Promise.all(
      images.map(async ({ file }) =>
        api.canvases.upload(canvasId, {
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }),
      ),
    );
    attachments = uploaded.flatMap((file) => (file.ref ? [file.ref] : []));
    await api.canvases.sendMessage(canvasId, { text, attachments });
    return true;
  } catch (error) {
    const files = attachments;
    if (!files || !wall) return false;
    const held: Held = {
      kind: "message",
      run: async () => {
        try {
          await api.canvases.sendMessage(canvasId, { text, attachments: files });
        } catch (again) {
          // At a limit again, it is held again; anything else, it didn't go.
          if (!wall.refused(again, held)) dropped();
        }
      },
      dropped,
    };
    return wall.refused(error, held) ? null : false;
  }
}
