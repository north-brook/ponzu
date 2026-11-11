import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Ask, AskAnswer, Person } from "../model.ts";
import { who } from "../thread/thread.ts";
import { Button, SendButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { safeHref } from "../ui/markdown.ts";
import { Prose } from "../ui/prose.tsx";
import {
  answerable,
  answerOf,
  CHOICES,
  choose,
  type Draft,
  EMPTY_DRAFT,
  type Page,
  pagesOf,
} from "./answer.ts";

const keyOf = (page: Page) => `${page.ask.id}:${page.index}`;
const isOpen = (ask: Ask) => ask.status === "open";

/**
 * What the agent waits on, in the composer's place: one page at a time under its own header,
 * with a pager across everything waiting. A question's options sit on one quiet track, the
 * chosen raised with a tick; a note goes with any answer, or is the answer. Send answers the
 * page in view and moves on, and sends an ask once its last page is answered. An ask someone
 * else answered, or the run moved past, says so until it is put away.
 */
export function NeedsYou({
  asks,
  meId,
  repoName,
  onAnswer,
  onDismiss,
  onOpenLink,
  onTouch,
}: {
  asks: Ask[];
  meId: string;
  /** Where a secret is kept: the repo's name, or null for Scratch. */
  repoName: string | null;
  onAnswer: (askId: string, answer: AskAnswer) => void;
  onDismiss: (askId: string) => void;
  onOpenLink: (url: string) => void;
  /** The viewer started answering this ask: chose something or typed a note. */
  onTouch?: (askId: string) => void;
}) {
  const pages = pagesOf(asks);
  const [current, setCurrent] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const at = Math.max(
    0,
    pages.findIndex((p) => keyOf(p) === current),
  );
  const page = pages[at];
  const options = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const moved = useRef(false);

  // After the person moves between pages, the keyboard goes with them.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const first = options.current?.querySelector<HTMLElement>("[data-option]");
    (first ?? note.current)?.focus();
  }, [current]);

  if (!page) return null;
  const draft = drafts[keyOf(page)] ?? EMPTY_DRAFT;
  const setDraft = (next: Draft) => {
    setDrafts((d) => ({ ...d, [keyOf(page)]: next }));
    onTouch?.(page.ask.id);
  };
  const go = (to: number) => {
    const next = pages[to];
    if (!next) return;
    moved.current = true;
    setCurrent(keyOf(next));
  };

  const { ask } = page;
  const closed = !isOpen(ask) && ask.status !== "sending";
  const busy = ask.status === "sending";
  const ready = isOpen(ask) && answerable(page, draft);

  const send = () => {
    if (!ready) return;
    const own = pages.filter((p) => p.ask.id === ask.id);
    const answer = answerOf(
      ask,
      own.map((p) => drafts[keyOf(p)] ?? EMPTY_DRAFT),
    );
    if (!answer) {
      // A page of this ask still says nothing: that one next.
      const missing = own.find((p) => !answerable(p, drafts[keyOf(p)] ?? EMPTY_DRAFT));
      if (missing) go(pages.indexOf(missing));
      return;
    }
    onAnswer(ask.id, answer);
    const next = pages.findIndex((p, i) => i > at && p.ask.id !== ask.id && isOpen(p.ask));
    if (next >= 0) go(next);
  };
  const advance = () => {
    // The ask's own next page, before it is sent.
    const next = pages[at + 1];
    if (next && next.ask.id === ask.id && ready) go(at + 1);
    else send();
  };

  const header =
    ask.kind === "question"
      ? ask.questions[page.index]!.header
      : { plan: "Plan", permission: "Permission", secret: "Secret", link: "Over to you" }[ask.kind];

  return (
    <section
      aria-label={`Ponzu needs you: ${header}`}
      // A long ask scrolls inside, leaving the thread at least a quarter of the rail.
      className="flex max-h-[75%] shrink-0 flex-col rounded-18 bg-bar p-1 shadow-bar backdrop-blur-[24px] backdrop-saturate-[1.4]"
    >
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pt-2.5 pr-2.5 pb-3 pl-3 [scrollbar-width:thin]">
        <div className="flex h-[22px] items-center gap-[9px]">
          <span aria-hidden className="size-2 shrink-0 rounded-pill bg-yuzu shadow-halo" />
          <h2 className="m-0 min-w-0 flex-1 truncate font-semibold text-13">{header}</h2>
          {pages.length > 1 ? <Pager at={at} count={pages.length} onGo={go} /> : null}
        </div>
        <PageBody
          page={page}
          draft={draft}
          disabled={!isOpen(ask)}
          optionsRef={options}
          onChoose={(label, multi) => setDraft(choose(draft, label, multi))}
          onOpenLink={(url) => {
            onOpenLink(url);
            if (ask.kind === "link") setDraft({ ...draft, chosen: ["yes"] });
          }}
        />
      </div>
      {closed ? (
        <Resolved status={ask.status} by={ask.answeredBy} meId={meId}>
          <Button
            variant="quiet"
            onClick={() => onDismiss(ask.id)}
            className="-my-1 px-2.5 text-ink"
          >
            {pages.some((p) => p.ask.id !== ask.id && isOpen(p.ask)) ? "Next" : "OK"}
          </Button>
        </Resolved>
      ) : (
        <div className="flex items-end gap-2 rounded-14 bg-surface py-2 pr-2 pl-3.5 shadow-note-field">
          {ask.kind === "secret" ? (
            <input
              ref={note}
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`The value of ${ask.name}`}
              placeholder="Paste the value"
              value={draft.note}
              readOnly={busy}
              onChange={(e) => setDraft({ ...draft, note: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  advance();
                }
              }}
              className="h-7 min-w-0 flex-1 bg-transparent font-mono text-12 text-ink outline-none [caret-color:var(--c-ink)] placeholder:font-sans placeholder:text-13 placeholder:text-faint"
            />
          ) : (
            <textarea
              ref={note}
              rows={1}
              dir="auto"
              aria-label="Note"
              placeholder={NOTE_PLACEHOLDER[ask.kind]}
              value={draft.note}
              // Read-only, not disabled, while the answer goes: the keyboard stays where it was.
              readOnly={busy}
              onChange={(e) => setDraft({ ...draft, note: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  advance();
                }
              }}
              className="max-h-[100px] min-w-0 flex-1 resize-none bg-transparent py-1 text-13 text-ink leading-5 outline-none [caret-color:var(--c-ink)] [field-sizing:content] [scrollbar-width:thin] placeholder:text-faint"
            />
          )}
          <SendButton
            size={28}
            iconSize={14}
            disabled={!ready}
            aria-busy={busy || undefined}
            onClick={advance}
          />
        </div>
      )}
      {ask.kind === "secret" && !closed ? (
        <p className="m-0 px-3.5 pt-2 pb-1.5 text-11 text-faint leading-[1.4]">
          {repoName
            ? `Kept with ${repoName}'s secrets for its designs. It never goes in the thread.`
            : "Kept for this design only. It never goes in the thread."}
        </p>
      ) : null}
    </section>
  );
}

const NOTE_PLACEHOLDER: Record<Exclude<Ask["kind"], "secret">, string> = {
  question: "Add a note, or answer in words",
  plan: "Add a note, or say what to change",
  permission: "Add a note",
  link: "Add a note",
};

function Pager({ at, count, onGo }: { at: number; count: number; onGo: (to: number) => void }) {
  const step =
    "grid size-[22px] cursor-default place-items-center rounded-6 outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover active:bg-press disabled:pointer-events-none disabled:text-faint";
  return (
    <div className="flex items-center gap-0.5 font-mono text-11 text-muted">
      <button
        type="button"
        aria-label="Previous"
        disabled={at === 0}
        onClick={() => onGo(at - 1)}
        className={step}
      >
        <Icon icon={ArrowLeft01Icon} size={12} stroke={2.2} />
      </button>
      <span aria-live="polite">
        {at + 1}/{count}
      </span>
      <button
        type="button"
        aria-label="Next"
        disabled={at === count - 1}
        onClick={() => onGo(at + 1)}
        className={step}
      >
        <Icon icon={ArrowRight01Icon} size={12} stroke={2.2} />
      </button>
    </div>
  );
}

function PageBody({
  page,
  draft,
  disabled,
  optionsRef,
  onChoose,
  onOpenLink,
}: {
  page: Page;
  draft: Draft;
  disabled: boolean;
  optionsRef: RefObject<HTMLDivElement | null>;
  onChoose: (label: string, multi: boolean) => void;
  onOpenLink: (url: string) => void;
}) {
  const { ask } = page;
  const lead = "m-0 font-medium text-13 leading-[1.45]";
  switch (ask.kind) {
    case "question": {
      const q = ask.questions[page.index]!;
      return (
        <div className="flex flex-col gap-2">
          <p className={lead}>
            {q.question}
            {q.multiSelect ? <span className="font-normal text-faint"> Choose any.</span> : null}
          </p>
          <Options
            ref={optionsRef}
            label={q.question}
            multi={q.multiSelect}
            options={q.options}
            chosen={draft.chosen}
            disabled={disabled}
            onChoose={(label) => onChoose(label, q.multiSelect)}
          />
        </div>
      );
    }
    case "plan":
    case "permission": {
      const choices = CHOICES[ask.kind];
      return (
        <div className="flex min-h-0 flex-col gap-2">
          {ask.kind === "plan" ? (
            <div className="max-h-[260px] overflow-y-auto rounded-10 bg-surface px-3 py-2.5 text-13 leading-[1.5] shadow-note-field [scrollbar-width:thin]">
              <Prose text={ask.plan} onOpenLink={onOpenLink} />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <p className={lead}>{ask.title}</p>
              {ask.description ? (
                <p className="m-0 text-12 text-muted leading-[1.4]">{ask.description}</p>
              ) : null}
              <p className="m-0 font-mono text-11 text-faint">{ask.tool}</p>
            </div>
          )}
          <Options
            ref={optionsRef}
            label={ask.kind === "plan" ? "Approve the plan?" : ask.title}
            multi={false}
            options={(["yes", "no"] as const).map((value) => ({
              value,
              label: choices[value],
              description: choices.description?.[value] ?? "",
            }))}
            chosen={draft.chosen}
            disabled={disabled}
            onChoose={(value) => onChoose(value, false)}
          />
        </div>
      );
    }
    case "secret":
      return (
        <div className="flex flex-col gap-1">
          <p className={lead}>
            Claude needs <span className="font-mono text-12">{ask.name}</span> to go on.
          </p>
          {ask.description ? (
            <p className="m-0 text-12 text-muted leading-[1.4]">{ask.description}</p>
          ) : null}
        </div>
      );
    case "link": {
      // The agent chose the address, so it may be anything: only a web address opens. Any other
      // is shown for what it is, and the ask can't be answered by opening it.
      const href = safeHref(ask.url);
      return (
        <div className="flex flex-col gap-2">
          <p className={lead}>{ask.title}</p>
          {ask.description ? (
            <p className="m-0 text-12 text-muted leading-[1.4]">{ask.description}</p>
          ) : null}
          {href ? (
            <div ref={optionsRef} className="flex flex-col rounded-11 bg-hover p-[3px]">
              <button
                type="button"
                data-option
                disabled={disabled}
                onClick={() => onOpenLink(href)}
                className={cn(
                  OPTION,
                  draft.chosen.length
                    ? "bg-raised shadow-chosen"
                    : "hover:bg-hover active:bg-press",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium text-13 leading-[1.3]">
                    Open {new URL(href).host || href}
                  </span>
                  <span className="truncate text-12 text-muted leading-[1.4]">
                    {draft.chosen.length ? "Opened. Send when you're done there." : href}
                  </span>
                </span>
                <Icon icon={ArrowUpRight01Icon} size={14} stroke={1.9} className="text-icon-soft" />
              </button>
            </div>
          ) : (
            <p className="m-0 flex flex-col gap-0.5 rounded-11 bg-hover px-2.5 py-[7px] text-12 text-muted leading-[1.4]">
              Not a web address, so Ponzu won't open it:
              <span className="font-mono text-11 text-ink [overflow-wrap:anywhere]">{ask.url}</span>
            </p>
          )}
        </div>
      );
    }
  }
}

const OPTION =
  "flex w-full cursor-default items-center gap-2.5 rounded-8 px-2.5 py-[7px] text-left outline-none transition-[background-color,box-shadow] duration-(--dur-hover) focus-ring disabled:pointer-events-none";

/**
 * The options, on one quiet track. One Tab stop: the arrows, Home and End move along them,
 * Space or Return chooses, and a digit chooses that option outright.
 */
function Options({
  ref,
  label,
  multi,
  options,
  chosen,
  disabled,
  onChoose,
}: {
  ref: RefObject<HTMLDivElement | null>;
  label: string;
  multi: boolean;
  options: { label: string; description: string; value?: string }[];
  chosen: string[];
  disabled: boolean;
  onChoose: (value: string) => void;
}) {
  const [focused, setFocused] = useState(0);
  const valueFor = (o: (typeof options)[number]) => o.value ?? o.label;
  const stop = Math.min(focused, options.length - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-option]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    // ⌘1 and the like are the app's and the window's.
    if (at < 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : null;
    if (digit !== null && options[digit]) {
      e.preventDefault();
      rows[digit]?.focus();
      onChoose(valueFor(options[digit]));
      return;
    }
    const to =
      e.key === "ArrowDown"
        ? (at + 1) % rows.length
        : e.key === "ArrowUp"
          ? (at - 1 + rows.length) % rows.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? rows.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  };

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a radiogroup or a group, both named
    <div
      ref={ref}
      role={multi ? "group" : "radiogroup"}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex flex-col gap-0.5 rounded-11 bg-hover p-[3px]", disabled && "opacity-60")}
    >
      {options.map((o, i) => {
        const on = chosen.includes(valueFor(o));
        return (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a radio or a checkbox, both checked or not
          <button
            key={valueFor(o)}
            type="button"
            data-option
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            tabIndex={i === stop ? 0 : -1}
            disabled={disabled}
            onFocus={() => setFocused(i)}
            onClick={() => onChoose(valueFor(o))}
            className={cn(
              OPTION,
              on ? "bg-raised shadow-chosen" : "hover:bg-hover active:bg-press",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium text-13 leading-[1.3]">{o.label}</span>
              {o.description ? (
                <span className="text-12 text-muted leading-[1.4]">{o.description}</span>
              ) : null}
            </span>
            {on ? <Icon icon={Tick02Icon} size={15} stroke={2.4} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Where the note field was, once the ask is closed: who answered it, or that nobody need. */
function Resolved({
  status,
  by,
  meId,
  children,
}: {
  status: Ask["status"];
  by: Person | null;
  meId: string;
  children: ReactNode;
}) {
  const said =
    status === "cancelled"
      ? "Claude moved on, so this needs no answer."
      : status === "closed"
        ? "No longer waiting on this."
        : by
          ? `${who(by, meId)} answered.`
          : "Answered.";
  return (
    <div className="flex items-center gap-2 rounded-14 bg-surface py-2 pr-2 pl-3.5 shadow-note-field">
      <span role="status" className="min-w-0 flex-1 py-1 text-13 text-muted leading-5">
        {said}
      </span>
      {children}
    </div>
  );
}
