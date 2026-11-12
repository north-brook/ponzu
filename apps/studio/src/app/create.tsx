import { type Api, ApiError } from "@ponzu/client";
import { useRepoIdeas } from "@ponzu/client/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ProjectChoice, RepoShelf } from "../cloud/create/create.ts";
import { CreatePage } from "../cloud/create/create-page.tsx";
import { ClaudeSignedOutDialog } from "../cloud/dialogs/account-dialogs.tsx";
import { type Effort, effortsOf, type PendingAttachment, type Repo } from "../cloud/model.ts";
import { useAnalytics } from "./analytics/provider.tsx";
import type { FreshDesign } from "./design.tsx";
import type { Host } from "./host.ts";
import { Banner } from "./notices.tsx";
import { usePonzu } from "./ponzu-query.tsx";
import { useClaudeConnect } from "./setup/claude-connect.ts";

/*
 * Fresh start: the create page, made real. Sending makes the design with its first message in
 * one call (POST /v1/designs), on the model and effort the picker shows (the last ones picked
 * here, on this Mac, or else the person's defaults), in the chosen repo or Scratch, and opens it. Each composition carries
 * a create key, so sending it twice makes one design. A prompt with images makes the design
 * first, uploads them to it, then says the message with them.
 *
 * What a send needs first opens over the window with the prompt kept, and the prompt goes once
 * it is done: a Claude not connected, or signed out. Nothing else blocks yet (no billing).
 */

/** The most a first name runs to, before it is cut at a word. */
const NAME_MAX = 40;

/**
 * What a design is called until the agent names it: what the first line of the prompt is about,
 * as a title. Its first clause, without the request's verb and article ("Design a pricing card:
 * a heading…" is "Pricing card"), cut at a word when it is still long.
 */
export function nameFor(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.trim();
  const clause = line.split(/(?<=[.!?])\s|[:;]\s|\s[—–-]\s/)[0]!.replace(/[\s.!?:;,]+$/, "");
  const topic = clause
    .replace(
      /^(?:(?:please|can you|could you)\s+)?(?:design|make|create|build|draw|mock up|sketch|redesign|add)\s+(?:me\s+|us\s+)?/i,
      "",
    )
    .replace(/^(?:a|an|the|some)\s+/i, "")
    .trim();
  const name = topic || line;
  const cut =
    name.length <= NAME_MAX
      ? name
      : `${name.slice(0, name.lastIndexOf(" ", NAME_MAX) > 12 ? name.lastIndexOf(" ", NAME_MAX) : NAME_MAX).replace(/[\s,;:]+$/, "")}…`;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** A new create key: the API takes 8 to 64 of `A-Za-z0-9_-`. */
export function newCreateKey(): string {
  return crypto.randomUUID();
}

type Me = Awaited<ReturnType<Api["me"]>>;

/** Whether a send can go now, or must connect the person's Claude first. */
export function claudeReady(me: Pick<Me, "claudeAccount"> | undefined): boolean {
  return me?.claudeAccount?.status === "connected";
}

/** An image picked to go with the prompt, held here until there is a design to upload it to. */
interface Picked extends PendingAttachment {
  file: File;
}

/**
 * The create page as it was when a repo in another workspace was chosen: the window switches to
 * that workspace (a new `WorkspaceWindow`, so a new create page) and hands this over, so the page
 * there opens with the repo chosen and the words, images and picked idea as they were.
 */
export interface CreateHandoff {
  workspaceId: string;
  project: ProjectChoice;
  prompt: string;
  picked: Picked[];
  idea: string | null;
}

export function CreateView({
  host,
  workspaceId,
  repos,
  elsewhere,
  handoff,
  onHandoffTaken,
  onSwitchWorkspace,
  showIdeas,
  onCreated,
  onAllowMore,
}: {
  host: Host;
  workspaceId: string;
  /** Repos the person can push to; null while they load. */
  repos: Repo[] | null;
  /** The other workspaces' repos the person can push to, those that have arrived. */
  elsewhere: RepoShelf[];
  /** What the create page in the workspace this window just left handed over, if anything. */
  handoff: CreateHandoff | null;
  onHandoffTaken: () => void;
  /** A repo in another workspace was chosen: switch to it, carrying the page over. */
  onSwitchWorkspace: (handoff: CreateHandoff) => void;
  /** Ideas show while the person is new to the workspace. */
  showIdeas: boolean;
  /**
   * The design is made: open it, with what its answer said, so it opens on its first message.
   * `messageFailed` when the first message didn't go.
   */
  onCreated: (design: FreshDesign, messageFailed: boolean) => void;
  onAllowMore: () => void;
}) {
  const { queries, mutations } = usePonzu();
  const me = useQuery(queries.me());
  const defaults = useQuery(queries.claudeDefaults());
  const create = useMutation(mutations.createDesign());
  // Handed over by the page in the workspace just left, or fresh.
  const [taken] = useState(() => (handoff?.workspaceId === workspaceId ? handoff : null));
  const [prompt, setPrompt] = useState(taken?.prompt ?? "");
  const [chosen, setChosen] = useState<ProjectChoice | null>(taken?.project ?? null);
  const [model, setModel] = useState<Choice | null>(loadChoice);
  const [picked, setPicked] = useState<Picked[]>(taken?.picked ?? []);
  const [sending, setSending] = useState(false);
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
  // A design sent before the repos are known is made in Scratch, as the API would.
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
  // The last choice holds while the account still offers it.
  const remembered =
    model &&
    defaults.data?.models.some((m) => m.id === model.model) &&
    effortsOf(defaults.data.models, defaults.data.efforts, model.model).includes(model.effort)
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
    try {
      const design = await create.mutateAsync({
        workspaceId,
        repoId: project.kind === "repo" ? project.repo.id : null,
        name: nameFor(text),
        // Without an answer about the defaults, the API starts the design on them itself.
        ...(choice ? { model: choice.model, effort: choice.effort } : {}),
        createKey: createKey.current,
        // With images, the message waits until they are files of the design.
        ...(images.length ? {} : { message: { text } }),
      });
      const idea = pickedIdea.current;
      analytics.capture("create prompt sent", {
        source: idea === null ? "typed" : idea.trim() === text ? "idea" : "idea_edited",
        project: project.kind,
        images: images.length,
      });
      pickedIdea.current = null;
      const said = images.length ? await sayWithImages(host.api, design.id, text, images) : true;
      createKey.current = newCreateKey();
      setPrompt("");
      release(images);
      setPicked([]);
      onCreated(
        {
          id: design.id,
          name: design.name,
          message: said ? text : null,
          access: design.access,
          head: {
            agentState: design.agentState,
            agentStatus: design.agentStatus,
            agentBlocker: design.agentBlocker,
          },
        },
        !said,
      );
    } catch (failure) {
      analytics.capture("notice shown", { notice: "design_not_made" });
      setError(
        failure instanceof ApiError && failure.code === "network"
          ? "Ponzu can't be reached. Check your connection and send it again."
          : "That design couldn't be made. Try again.",
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

/** Where the last model and effort picked here are kept, so the next design starts on them. */
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

/** Uploads the images to the new design, then says the message with them. */
async function sayWithImages(
  api: Api,
  designId: string,
  text: string,
  images: Picked[],
): Promise<boolean> {
  try {
    const uploaded = await Promise.all(
      images.map(async ({ file }) =>
        api.designs.upload(designId, {
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }),
      ),
    );
    const attachments = uploaded.flatMap((file) => (file.ref ? [file.ref] : []));
    await api.designs.sendMessage(designId, { text, attachments });
    return true;
  } catch {
    return false;
  }
}
