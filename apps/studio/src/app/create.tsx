import { type Api, ApiError } from "@ponzu/client";
import { useRepoIdeas } from "@ponzu/client/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ProjectChoice } from "../cloud/create/create.ts";
import { CreatePage } from "../cloud/create/create-page.tsx";
import { ClaudeSignedOutDialog } from "../cloud/dialogs/account-dialogs.tsx";
import type { Effort, PendingAttachment, Repo } from "../cloud/model.ts";
import type { Host } from "./host.ts";
import { Banner } from "./notices.tsx";
import { usePonzu } from "./ponzu-query.tsx";
import { useClaudeConnect } from "./setup/claude-connect.ts";

/*
 * Fresh start: the create page, made real. Sending makes the design with its first message in
 * one call (POST /v1/designs), on the model and effort the picker shows (the person's defaults
 * until they change it), in the chosen repo or Scratch, and opens it. Each composition carries
 * a create key, so sending it twice makes one design. A prompt with images makes the design
 * first, uploads them to it, then says the message with them.
 *
 * What a send needs first opens over the window with the prompt kept, and the prompt goes once
 * it is done: a Claude not connected, or signed out. Nothing else blocks yet (no billing).
 */

/** A design is called by the first line of what it was asked, until the agent names it. */
export function nameFor(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
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

export function CreateView({
  host,
  workspaceId,
  repos,
  showIdeas,
  onCreated,
  onAllowMore,
}: {
  host: Host;
  workspaceId: string;
  /** Repos the person can push to; null while they load. */
  repos: Repo[] | null;
  /** Ideas show while the person is new to the workspace. */
  showIdeas: boolean;
  /** The design is made: open it. `messageFailed` when the first message didn't go. */
  onCreated: (designId: string, messageFailed: boolean) => void;
  onAllowMore: () => void;
}) {
  const { queries, mutations } = usePonzu();
  const me = useQuery(queries.me());
  const defaults = useQuery(queries.claudeDefaults());
  const create = useMutation(mutations.createDesign());
  const [prompt, setPrompt] = useState("");
  const [chosen, setChosen] = useState<ProjectChoice | null>(null);
  const [model, setModel] = useState<{ model: string; effort: Effort } | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsClaude, setNeedsClaude] = useState(false);
  const [sendOnceConnected, setSendOnceConnected] = useState(false);
  const createKey = useRef(newCreateKey());
  const going = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  // Until the person picks, the repo pushed to last, or Scratch when there is none.
  const project: ProjectChoice =
    chosen ?? (repos?.[0] ? { kind: "repo", repo: repos[0] } : { kind: "scratch" });
  const ideas = useRepoIdeas(
    host.api,
    showIdeas && project.kind === "repo" ? project.repo.id : null,
  );
  const choice =
    model ?? (defaults.data ? { model: defaults.data.model, effort: defaults.data.effort } : null);
  const ready = claudeReady(me.data);

  const connect = useClaudeConnect({
    openExternal: host.openExternal,
    onConnected: () => {
      setNeedsClaude(false);
      setSendOnceConnected(true);
    },
  });

  // The pictures picked are let go of when they are taken out, sent, or the page goes.
  const shown = useRef(picked);
  shown.current = picked;
  useEffect(() => () => release(shown.current), []);

  const send = async () => {
    const text = prompt.trim();
    if (!text || !choice || going.current) return;
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
        model: choice.model,
        effort: choice.effort,
        createKey: createKey.current,
        // With images, the message waits until they are files of the design.
        ...(images.length ? {} : { message: { text } }),
      });
      const said = images.length ? await sayWithImages(host.api, design.id, text, images) : true;
      createKey.current = newCreateKey();
      setPrompt("");
      release(images);
      setPicked([]);
      onCreated(design.id, !said);
    } catch (failure) {
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

  if (!defaults.data || !choice) return null;
  return (
    <>
      <CreatePage
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={() => void send()}
        onAttach={() => picker.current?.click()}
        sending={sending}
        model={{
          models: defaults.data.models,
          efforts: defaults.data.efforts,
          model: choice.model,
          effort: choice.effort,
          onChange: (id, effort) => setModel({ model: id, effort }),
        }}
        project={project}
        repos={repos}
        onProjectChange={setChosen}
        onAllowMore={onAllowMore}
        ideas={ideas}
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
        onDismiss={() => setNeedsClaude(false)}
        card={connect}
        connected={me.data?.claudeAccount != null}
      />
      {error ? <Banner>{error}</Banner> : null}
    </>
  );
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
        api.designs.upload(
          designId,
          { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
          "attachment",
        ),
      ),
    );
    const attachments = uploaded.flatMap((file) => (file.ref ? [file.ref] : []));
    await api.designs.sendMessage(designId, { text, attachments });
    return true;
  } catch {
    return false;
  }
}
