import { DashboardSquare01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useState } from "react";
import {
  type BoardHit,
  type CommentHit,
  type DesignHit,
  firstName,
  type Match,
  type SearchResults,
} from "../model.ts";
import { moveSelection, type ResultKey, resultKeys, segments } from "../search.ts";
import { ago, useNow } from "../time.ts";
import { Avatar } from "../ui/avatar.tsx";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { Kbd } from "../ui/kbd.tsx";
import { DesignPreviewImage } from "./design-preview.tsx";

const LIST_ID = "search-results";
const optionId = (key: ResultKey) => `search-${key.replace(":", "-")}`;

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
}: {
  fieldRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResults | null;
  selected: ResultKey | null;
  onSelect: (key: ResultKey) => void;
  onOpenResult: (key: ResultKey) => void;
  onClose: () => void;
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
    <div className="flex h-[34px] shrink-0 items-center gap-2 rounded-9 bg-surface pr-2 pl-2.5 shadow-[0_0_0_1px_var(--c-rule)]">
      <Icon icon={Search01Icon} size={15} stroke={1.8} className="text-icon-soft" />
      <input
        type="search"
        role="combobox"
        aria-label="Search designs, boards and comments"
        aria-expanded={keys.length > 0}
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={selected ? optionId(selected) : undefined}
        ref={fieldRef}
        spellCheck={false}
        placeholder="Search"
        value={query}
        onChange={(e) => onQueryChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!query.trim()) onClose();
        }}
        className="min-w-0 flex-1 appearance-none bg-transparent text-13 text-ink outline-none [caret-color:var(--c-yuzu)] placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
      />
      <Kbd>esc</Kbd>
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
 * Results as you type, in up to three groups (Designs, Boards, Comments) with what matched
 * highlighted. `results` is null while the first answer for the query is on its way; a line says
 * so only if that takes longer than a moment.
 */
export function SearchResultsView({
  query,
  results,
  selected,
  onSelect,
  onOpenResult,
}: {
  query: string;
  results: SearchResults | null;
  selected: ResultKey | null;
  onSelect: (key: ResultKey) => void;
  onOpenResult: (key: ResultKey) => void;
}) {
  const slow = useAfter(300, results === null);
  const now = useNow();

  // The field keeps focus, so the selection has to bring itself into view.
  useEffect(() => {
    if (selected) document.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!results) {
    return slow ? <Note>Searching…</Note> : null;
  }
  if (!resultKeys(results).length) {
    return <Note>No results for “{query.trim()}”</Note>;
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

  return (
    <FadeScroll className="flex-1">
      <div
        id={LIST_ID}
        role="listbox"
        aria-label="Search results"
        // Designs' and boards' names and people's comments: masked in a private recording
        // (app/analytics/privacy.ts).
        data-replay="mask"
        className="flex flex-col"
      >
        <Group label="Designs" hits={results.designs}>
          {(hit: DesignHit) =>
            option(
              `design:${hit.design.id}`,
              <DesignPreviewImage preview={hit.design.preview} width={40} height={26} />,
              <Highlighted text={hit.design.name} matches={hit.matches} />,
              designLine(hit, now),
            )
          }
        </Group>
        <Group label="Boards" hits={results.boards}>
          {(hit: BoardHit) =>
            option(
              `board:${hit.id}`,
              <span className="grid h-[26px] w-10 shrink-0 place-items-center rounded-4 bg-hover text-icon-soft">
                <Icon icon={DashboardSquare01Icon} size={14} stroke={1.8} />
              </span>,
              <Highlighted text={hit.name} matches={hit.matches} />,
              `in ${hit.design.name}`,
            )
          }
        </Group>
        <Group label="Comments" hits={results.comments}>
          {(hit: CommentHit) =>
            option(
              `comment:${hit.id}`,
              <Avatar person={hit.author} size={26} />,
              <>
                “<Highlighted text={hit.text} matches={hit.matches} />”
              </>,
              `${firstName(hit.author)} · ${hit.design.name} · ${ago(hit.at, now, "short")}`,
            )
          }
        </Group>
      </div>
    </FadeScroll>
  );
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
  const id = `search-group-${label.toLowerCase()}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group"
    <div role="group" aria-labelledby={id} className="mt-2.5 flex flex-col gap-px">
      <span id={id} className="px-2 pb-1 font-medium text-11 text-faint">
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

/** An open design says where it is; a settled one, whose it was and when. */
function designLine({ design }: DesignHit, now: number): string {
  const { project } = design;
  const where = project.kind === "repo" ? project.repo.name : project.city;
  if (design.status === "settled") {
    const parts = [where];
    if (design.owner) parts.push(firstName(design.owner));
    if (design.settledAt) parts.push(ago(design.settledAt, now, "long"));
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
