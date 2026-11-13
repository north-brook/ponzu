import {
  Cancel01Icon,
  DashboardSquare01Icon,
  GitPullRequestIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Icon as PageIcon } from "@ponzu/canvas/icons";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useState } from "react";
import {
  type BoardHit,
  type CanvasHit,
  type CommentHit,
  firstName,
  type HitAuthor,
  type Match,
  type MessageHit,
  type Person,
  type PersonHit,
  type PrState,
  type PullRequestHit,
  type SearchResults,
} from "../model.ts";
import { moveSelection, type ResultKey, resultKey, resultKeys, segments } from "../search.ts";
import { ago, useNow } from "../time.ts";
import { Avatar } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { TEXT } from "../ui/ladder.ts";
import { AgentMark } from "../ui/marks.tsx";
import { CanvasPreviewImage } from "./canvas-preview.tsx";

const LIST_ID = "search-results";
/** An option's element id: its key, with anything an id selector would trip on as "-". */
const optionId = (key: ResultKey) => `search-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** The field's name for assistive technology: what search finds. */
export const SEARCH_LABEL = "Search canvases, boards, comments and messages";
/** How the canvas's agent is named in a result. */
const AGENT_NAME = "Claude";
/** How someone who deleted their account is named, as the thread names them. */
const DELETED_NAME = "Deleted user";

/**
 * The search field, in the header row's place, focused as it opens. Arrow keys move the
 * selection through the results below it, Return opens the selected one, Escape clears and
 * closes. Leaving it empty closes it too.
 */
export function SearchField({
  fieldRef,
  query,
  onQueryChange,
  results,
  selected,
  onSelect,
  onOpenResult,
  onClose,
  maxLength,
}: {
  fieldRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResults | null;
  selected: ResultKey | null;
  onSelect: (key: ResultKey) => void;
  onOpenResult: (key: ResultKey) => void;
  onClose: () => void;
  /** The longest query the field takes: the API's limit. */
  maxLength?: number;
}) {
  const keys = results ? resultKeys(results) : [];

  // Without scrolling: a sidebar opening from collapsed would otherwise slide its content aside.
  useEffect(() => {
    fieldRef.current?.focus({ preventScroll: true });
  }, [fieldRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      if (selected) onOpenResult(selected);
      return;
    }
    const at = selected ? keys.indexOf(selected) : -1;
    const next = moveSelection(keys.length, at, e.key);
    if (next === null) return;
    e.preventDefault();
    onSelect(keys[next]!);
  };

  return (
    // It opens out of the search button's place in the header row it replaces (search-open).
    <div className="search-open flex h-[34px] shrink-0 items-center gap-2 rounded-9 bg-surface pr-1 pl-2.5 shadow-[0_0_0_1px_var(--c-rule)]">
      <Icon icon={Search01Icon} step="control" className="text-icon-soft" />
      <input
        type="search"
        role="combobox"
        aria-label={SEARCH_LABEL}
        aria-expanded={keys.length > 0}
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={selected ? optionId(selected) : undefined}
        ref={fieldRef}
        spellCheck={false}
        {...(maxLength ? { maxLength } : {})}
        placeholder="Search"
        value={query}
        onChange={(e) => onQueryChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!query.trim()) onClose();
        }}
        className="min-w-0 flex-1 appearance-none bg-transparent text-13 text-ink outline-none [caret-color:var(--c-yuzu)] placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
      />
      {/* Closes it, as Escape does. Not a Tab stop: Escape is the keyboard's way out, and the
          field keeps the keys. The press is taken before the field's blur can close it first. */}
      <button
        type="button"
        aria-label="Close search"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="grid size-6 shrink-0 cursor-default place-items-center rounded-6 text-icon-soft outline-none transition-colors duration-(--dur-hover) hover:bg-hover hover:text-ink active:bg-press"
      >
        <Icon icon={Cancel01Icon} step="inline" />
      </button>
    </div>
  );
}

/**
 * Keeps the first result selected as results arrive, and the selection on its result while it
 * is still among them.
 */
export function useResultSelection(results: SearchResults | null) {
  const [selected, setSelected] = useState<ResultKey | null>(null);
  useEffect(() => {
    const keys = results ? resultKeys(results) : [];
    setSelected((current) => (current && keys.includes(current) ? current : (keys[0] ?? null)));
  }, [results]);
  return [selected, setSelected] as const;
}

/**
 * Results as you type, in groups (Canvases, Boards, Comments, Messages, Pull requests, People)
 * with what matched highlighted.
 * `results` is null while the first answer for the query is on its way; a line says so only if
 * that takes longer than a moment. `failed`: search didn't answer, and there is nothing to show.
 */
export function SearchResultsView({
  query,
  results,
  busy = false,
  failed = false,
  selected,
  onSelect,
  onOpenResult,
}: {
  query: string;
  results: SearchResults | null;
  /** `results` aren't the answer to `query` yet: the last answer, or names alone. */
  busy?: boolean;
  failed?: boolean;
  selected: ResultKey | null;
  onSelect: (key: ResultKey) => void;
  onOpenResult: (key: ResultKey) => void;
}) {
  const count = results ? resultKeys(results).length : 0;
  // An empty answer to the last words says nothing about these: the list waits for theirs.
  const waiting = results === null || (busy && count === 0);
  const slow = useAfter(300, waiting && !failed);
  const now = useNow();

  // The field keeps focus, so the selection has to bring itself into view.
  useEffect(() => {
    if (selected) document.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Said as an answer lands, for someone who can't see the list change. The region is there,
  // empty, from the moment search opens, since a live region added with its words already in it
  // is often not read out; and it says nothing over a list that isn't the answer yet.
  const status = (
    <p role="status" className="sr-only">
      {count && !busy ? (count === 1 ? "1 result" : `${count} results`) : ""}
    </p>
  );

  if (!results || waiting) {
    return withStatus(
      status,
      failed ? (
        <Note>Search isn't answering. Try again in a moment.</Note>
      ) : slow ? (
        <Note>Searching…</Note>
      ) : null,
    );
  }
  if (!count) {
    return withStatus(status, <Note>No results for “{query.trim()}”</Note>);
  }

  const option = (key: ResultKey, leading: ReactNode, title: ReactNode, sub: string) => (
    // The field keeps focus; options are pointed at with aria-activedescendant.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox handles the keyboard
    <div
      key={key}
      id={optionId(key)}
      role="option"
      tabIndex={-1}
      aria-selected={key === selected}
      onMouseMove={() => onSelect(key)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onOpenResult(key)}
      className="flex cursor-default select-none items-center gap-2.5 rounded-8 px-2 py-1.5 aria-selected:bg-selected"
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-13">{title}</span>
        <span className="truncate text-11 text-faint">{sub}</span>
      </span>
    </div>
  );

  return withStatus(
    status,
    <FadeScroll className="flex-1">
      <div
        id={LIST_ID}
        role="listbox"
        aria-label="Search results"
        // What shows while the answer to what is typed now is on its way.
        aria-busy={busy || undefined}
        // Names, what people and the agent said, pull requests' titles and who people are:
        // masked in a private recording
        // (app/analytics/privacy.ts).
        data-replay="mask"
        className="flex flex-col"
      >
        <Group label="Canvases" hits={results.canvases}>
          {(hit: CanvasHit) =>
            option(
              resultKey({ kind: "canvas", hit }),
              <CanvasPreviewImage preview={hit.canvas.preview} width={40} height={26} />,
              <Highlighted text={hit.canvas.name} matches={hit.matches} />,
              canvasLine(hit, now),
            )
          }
        </Group>
        <Group label="Boards" hits={results.boards}>
          {(hit: BoardHit) =>
            option(
              resultKey({ kind: hit.place, hit }),
              <Tile>
                {hit.place === "page" && hit.icon ? (
                  <PageIcon name={hit.icon} step="inline" />
                ) : (
                  <Icon icon={DashboardSquare01Icon} step="inline" />
                )}
              </Tile>,
              <Highlighted text={hit.name} matches={hit.matches} />,
              hit.place === "page" ? `Page in ${hit.canvas.name}` : `in ${hit.canvas.name}`,
            )
          }
        </Group>
        <Group label="Comments" hits={results.comments}>
          {(hit: CommentHit) =>
            option(
              resultKey({ kind: "comment", hit }),
              <AuthorAvatar author={hit.author} />,
              <>
                “<Highlighted text={hit.snippet} matches={hit.matches} />”
              </>,
              commentLine(hit, now),
            )
          }
        </Group>
        <Group label="Messages" hits={results.messages}>
          {(hit: MessageHit) =>
            option(
              resultKey({ kind: "message", hit }),
              <AuthorAvatar author={hit.author} />,
              <>
                “<Highlighted text={hit.snippet} matches={hit.matches} />”
              </>,
              saidLine(hit, now),
            )
          }
        </Group>
        <Group label="Pull requests" hits={results.pullRequests}>
          {(hit: PullRequestHit) =>
            option(
              resultKey({ kind: "pr", hit }),
              <Tile>
                <Icon icon={GitPullRequestIcon} step="inline" />
              </Tile>,
              <Highlighted text={hit.title} matches={hit.matches} />,
              pullRequestLine(hit),
            )
          }
        </Group>
        <Group label="People" hits={results.people}>
          {(hit: PersonHit) =>
            option(
              resultKey({ kind: "person", hit }),
              <Avatar person={personOf(hit)} size={26} />,
              hit.name ? (
                <Highlighted text={hit.name} matches={hit.nameMatches} />
              ) : (
                <Highlighted text={hit.login} matches={hit.loginMatches} />
              ),
              `@${hit.login}`,
            )
          }
        </Group>
      </div>
    </FadeScroll>,
  );
}

/** The results' count first, in the same place whatever shows after it, so it stays mounted. */
function withStatus(status: ReactNode, shown: ReactNode) {
  return (
    <>
      {status}
      {shown}
    </>
  );
}

/** A board's or a page's leading tile, the size of a canvas's preview. */
function Tile({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-[26px] w-10 shrink-0 place-items-center rounded-4 bg-hover text-icon-soft">
      {children}
    </span>
  );
}

/** Who said it: their avatar, the agent's mark, or an empty avatar for someone gone. */
function AuthorAvatar({ author }: { author: HitAuthor }) {
  if (author === "agent") {
    return (
      <span
        aria-hidden
        className="grid size-[26px] shrink-0 place-items-center rounded-full bg-chip"
      >
        <AgentMark client="claude" size={14} />
      </span>
    );
  }
  if (author === "deleted") {
    return <span aria-hidden className="size-[26px] shrink-0 rounded-full bg-chip" />;
  }
  return <Avatar person={author} size={26} />;
}

/** A person found, as an avatar draws them: their login when GitHub shows no name. */
function personOf(hit: PersonHit): Person {
  return { id: hit.id, name: hit.name ?? hit.login, login: hit.login, avatarUrl: hit.avatarUrl };
}

/** How a result's dense line names who said it. */
export function authorName(author: HitAuthor): string {
  if (author === "agent") return AGENT_NAME;
  if (author === "deleted") return DELETED_NAME;
  return firstName(author);
}

/** "Maya · Onboarding · 2h", with " · Resolved" for a resolved thread's. */
function commentLine(hit: CommentHit, now: number): string {
  const line = saidLine(hit, now);
  return hit.resolved ? `${line} · Resolved` : line;
}

/** Who said it, on which canvas, and when: "Maya · Onboarding · 2h". */
function saidLine(hit: CommentHit | MessageHit, now: number): string {
  const parts = [authorName(hit.author), hit.canvas.name];
  if (hit.at) parts.push(ago(hit.at, now, "short"));
  return parts.join(" · ");
}

const PR_STATE: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/**
 * "#412 · Open · Onboarding". A state only for the canvas's current pull request: an earlier
 * one's isn't known now, so the line says none rather than an old one.
 */
function pullRequestLine(hit: PullRequestHit): string {
  const parts = [`#${hit.number}`];
  if (hit.state) parts.push(PR_STATE[hit.state]);
  parts.push(hit.canvas.name);
  return parts.join(" · ");
}

function Group<T>({
  label,
  hits,
  children,
}: {
  label: string;
  hits: T[];
  children: (hit: T) => ReactNode;
}) {
  if (!hits.length) return null;
  // "Pull requests" gives "search-group-pull-requests": an id holds no space.
  const id = `search-group-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group"
    <div role="group" aria-labelledby={id} className="mt-2.5 flex flex-col gap-px">
      <span id={id} className={cn("px-2 pb-1", TEXT.label)}>
        {label}
      </span>
      {hits.map(children)}
    </div>
  );
}

/** The text with each match on a pith ground. */
export function Highlighted({ text, matches }: { text: string; matches: readonly Match[] }) {
  return (
    <>
      {segments(text, matches).map((s, i) =>
        s.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <mark key={i} className="rounded-3 bg-pith px-px text-inherit">
            {s.text}
          </mark>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** An open canvas says where it is; a settled one, whose it was and when. */
function canvasLine({ canvas }: CanvasHit, now: number): string {
  const { project } = canvas;
  const where = project.kind === "repo" ? project.repo.name : project.city;
  if (canvas.status === "settled") {
    const parts = [where];
    if (canvas.owner) parts.push(firstName(canvas.owner));
    if (canvas.settledAt) parts.push(ago(canvas.settledAt, now, "long"));
    return parts.join(" · ");
  }
  return project.kind === "repo" ? `${where} · ${project.branch}` : `Scratch · ${where}`;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 mt-2.5 px-2 text-13 text-muted">
      {children}
    </p>
  );
}

function useAfter(ms: number, active: boolean): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    setPassed(false);
    if (!active) return;
    const timer = setTimeout(() => setPassed(true), ms);
    return () => clearTimeout(timer);
  }, [ms, active]);
  return passed;
}
