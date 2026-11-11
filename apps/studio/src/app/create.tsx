import { ApiError } from "@ponzu/client";
import { useState } from "react";
import type { ProjectChoice } from "../cloud/create/create.ts";
import { CreatePage } from "../cloud/create/create-page.tsx";
import type { Effort, ModelOption, Repo } from "../cloud/model.ts";
import type { Host } from "./host.ts";
import { Banner } from "./notices.tsx";

/*
 * Fresh start: the create page, made real. Sending makes the design (POST /v1/designs) in the
 * chosen repo or Scratch, then says the first message in it, and opens it.
 *
 * SEAM(create with a first message): the lifecycle track adds one route that does both and
 * takes the model and effort; until then the two calls run one after the other, and the
 * model picker's choice isn't sent anywhere.
 */

const MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A design is called by the first line of what it was asked, until the agent names it. */
export function nameFor(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

export function CreateView({
  host,
  workspaceId,
  repos,
  onCreated,
  onAllowMore,
}: {
  host: Host;
  workspaceId: string;
  /** Repos the person can push to; null while they load. */
  repos: Repo[] | null;
  /** The design is made: open it. `messageFailed` when the first message didn't go. */
  onCreated: (designId: string, messageFailed: boolean) => void;
  onAllowMore: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [chosen, setChosen] = useState<ProjectChoice | null>(null);
  const [model, setModel] = useState({ model: MODELS[0]!.id, effort: "high" as Effort });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the person picks, the repo pushed to last, or Scratch when there is none.
  const project: ProjectChoice =
    chosen ?? (repos?.[0] ? { kind: "repo", repo: repos[0] } : { kind: "scratch" });

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    let designId: string;
    try {
      const design = await host.api.designs.create({
        workspaceId,
        repoId: project.kind === "repo" ? project.repo.id : null,
        name: nameFor(text),
      });
      designId = design.id;
    } catch (failure) {
      setSending(false);
      setError(
        failure instanceof ApiError && failure.code === "network"
          ? "Ponzu can't be reached. Check your connection and send it again."
          : "That design couldn't be made. Try again.",
      );
      return;
    }
    const sent = await host.api.designs.sendMessage(designId, { text }).then(
      () => true,
      () => false,
    );
    setPrompt("");
    setSending(false);
    onCreated(designId, !sent);
  };

  return (
    <>
      <CreatePage
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={send}
        // SEAM(attachments): a message's images upload to a design, which doesn't exist yet here.
        onAttach={() => {}}
        sending={sending}
        model={{
          models: MODELS,
          efforts: EFFORTS,
          model: model.model,
          effort: model.effort,
          onChange: (id, effort) => setModel({ model: id, effort }),
        }}
        project={project}
        repos={repos}
        onProjectChange={setChosen}
        onAllowMore={onAllowMore}
        ideas={null}
      />
      {error ? <Banner>{error}</Banner> : null}
    </>
  );
}
