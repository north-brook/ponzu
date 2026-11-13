import { LinkSquare02Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type { LinkedPullRequest } from "@ponzu/client";
import { type FormEvent, useState } from "react";
import { checksGlyph, pullRequestIcon } from "../pull-request.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Button, IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { InputGroup, InputGroupInput } from "../ui/input-group.tsx";
import { TEXT } from "../ui/ladder.ts";
import { AgentMark } from "../ui/marks.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/menu.tsx";
import { ChecksMark, PULL_REQUEST_ICONS } from "../window/pull-request-mark.tsx";

/*
 * The pull request tab's "Linked pull requests" (docs/cloud.md, "Linked pull requests"): those a
 * person or their agent said are this canvas's work besides its branch's, each with its state,
 * where it is, who linked it, and a way to GitHub; and, for someone who can steer the canvas, a
 * field to link another by its URL and a menu to unlink one. A link's title is what someone on
 * GitHub wrote: drawn as text, never markup.
 */

const ICON_COLORS = {
  open: "text-pr-open",
  draft: "text-icon-soft",
  conflict: "text-pr-conflict",
  closed: "text-muted",
  merged: "text-pr-merged",
} as const;

/** The agent's mark for the name it gave ("Claude Code", "Codex"), when it is one Ponzu draws. */
function agentClient(via: string | null): string | undefined {
  const name = via?.toLowerCase() ?? "";
  if (name.includes("claude")) return "claude";
  if (name.includes("codex") || name.includes("openai")) return "openai";
  return undefined;
}

export interface LinkedSectionProps {
  linked: readonly LinkedPullRequest[];
  /** Still reading the list, the first time. */
  loading: boolean;
  onOpenLink: (url: string) => void;
  /**
   * Links the pull request at `url`; answers the refusal's sentence to show under the field, or
   * null once linked. Absent for someone who can only look.
   */
  onLink?: ((url: string) => Promise<string | null>) | null;
  /** Unlinks one. Absent for someone who can only look. */
  onUnlink?: ((pr: LinkedPullRequest) => void) | null;
}

export function LinkedSection({
  linked,
  loading,
  onOpenLink,
  onLink,
  onUnlink,
}: LinkedSectionProps) {
  if (!onLink && linked.length === 0) return null;
  return (
    <section aria-label="Linked pull requests" className="flex flex-col">
      <h2 className={cn("m-0 pb-3", TEXT.label)}>Linked pull requests</h2>
      <div className="flex flex-col">
        {linked.map((pr) => (
          <LinkedRow
            key={`${pr.repoId}#${pr.number}`}
            pr={pr}
            onOpenLink={onOpenLink}
            onUnlink={onUnlink ?? null}
          />
        ))}
        {linked.length === 0 && !loading ? (
          <p className="m-0 flex h-7 items-center text-13 text-muted">
            None yet. Link the pull requests this canvas's work went into.
          </p>
        ) : null}
      </div>
      {onLink ? <LinkField onLink={onLink} /> : null}
    </section>
  );
}

function LinkedRow({
  pr,
  onOpenLink,
  onUnlink,
}: {
  pr: LinkedPullRequest;
  onOpenLink: (url: string) => void;
  onUnlink: ((pr: LinkedPullRequest) => void) | null;
}) {
  const state = pullRequestIcon(pr);
  const glyph = checksGlyph(pr);
  const where = `${pr.repository}#${pr.number}`;
  const by =
    pr.source === "agent"
      ? `Linked by ${pr.via ?? "an agent"}${pr.linkedBy ? ` for ${pr.linkedBy.name}` : ""}`
      : `Linked by ${pr.linkedBy?.name ?? "someone"}`;
  return (
    <div className="group flex min-h-9 items-center gap-2 text-13" title={by}>
      <Icon icon={PULL_REQUEST_ICONS[state]} step="small" className={ICON_COLORS[state]} />
      <span className="shrink-0 font-mono text-12 text-muted">{where}</span>
      <span className="min-w-0 flex-1 truncate">{pr.title}</span>
      {glyph ? <ChecksMark glyph={glyph} tone="colored" /> : null}
      <span className="sr-only">{by}</span>
      <span aria-hidden className="flex shrink-0 items-center">
        {pr.source === "agent" ? (
          <span className="grid size-5 place-items-center rounded-pill bg-chip">
            <AgentMark client={agentClient(pr.via)} size={11} />
          </span>
        ) : pr.linkedBy ? (
          <Avatar
            person={{
              id: pr.linkedBy.id,
              name: pr.linkedBy.name,
              login: pr.linkedBy.name,
              avatarUrl: pr.linkedBy.avatarUrl,
            }}
            size={20}
          />
        ) : null}
      </span>
      <IconButton
        label={`Open ${where} on GitHub`}
        onClick={() => onOpenLink(pr.url)}
        className="size-7 shrink-0 rounded-7 text-icon-soft"
      >
        <Icon icon={LinkSquare02Icon} step="meta" />
      </IconButton>
      {onUnlink ? (
        <Menu>
          <MenuTrigger asChild>
            <IconButton
              label={`More for ${where}`}
              className="-mr-1 size-7 shrink-0 rounded-7 text-icon-soft"
            >
              <Icon icon={MoreHorizontalIcon} step="control" />
            </IconButton>
          </MenuTrigger>
          <MenuContent width="max-content" side="bottom" align="end" sideOffset={4}>
            <MenuItem onSelect={() => onUnlink(pr)}>Unlink from this canvas</MenuItem>
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}

/** Paste a pull request's link to link it; a refusal's sentence shows under the field. */
function LinkField({ onLink }: { onLink: (url: string) => Promise<string | null> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const given = url.trim();
    if (!given || busy) return;
    setBusy(true);
    setRefusal(null);
    onLink(given).then(
      (refused) => {
        setBusy(false);
        setRefusal(refused);
        if (!refused) setUrl("");
      },
      () => {
        setBusy(false);
        setRefusal("Couldn't reach Ponzu. Try again.");
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5 pt-2">
      <div className="flex items-center gap-2">
        <InputGroup size="compact" className="min-w-0 flex-1">
          <InputGroupInput
            aria-label="Link a pull request"
            aria-invalid={refusal !== null}
            placeholder="https://github.com/owner/repo/pull/12"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (refusal) setRefusal(null);
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </InputGroup>
        <Button variant="quiet" type="submit" disabled={busy || !url.trim()} className="h-7 px-2.5">
          Link
        </Button>
      </div>
      {refusal ? (
        <p role="alert" className="m-0 text-12 text-muted leading-[1.45]">
          {refusal}
        </p>
      ) : null}
    </form>
  );
}
