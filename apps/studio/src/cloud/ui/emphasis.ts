/*
 * Emphasis (`*a*`, `__b__`) and strikethrough (`~~c~~`) for micromark, paired in time that grows
 * with the length of the text rather than its square.
 *
 * micromark (micromark-core-commonmark's `attention`, GFM's strikethrough) finds the opening
 * mark for each closing one by walking back through every event before it, and rewrites the
 * whole list of events for each pair it finds, so a paragraph dense with closing marks costs the
 * square of its length: 32 KB of `abc* ` took 0.32 to 0.75 s to draw, and four seconds on a
 * busy machine. These constructs keep micromark's tokenizers and make the same pairs, but find
 * them the way CommonMark's reference parser does: from a stack of the marks that may still
 * open, with a floor for each kind of closing mark below which nothing on the stack can open it,
 * so no mark is passed over twice for the same reason. The events are written once, at the end.
 * What they make is what micromark makes, tree for tree and position for position:
 * emphasis.test.ts compares the two on a hundred thousand generated texts.
 *
 * The rules of micromark's that this keeps:
 *
 * - At the top of a paragraph each kind is paired over the whole of it, in the order micromark
 *   first met the kinds. A closing mark takes the nearest mark before it that may open it.
 *   Emphasis takes one or two marks from each side and may pair again with what is left (with
 *   the rule of three on what is left); strikethrough pairs runs of the same length, whole.
 * - When a pair is made, what is directly inside it is paired again on its own: strikethrough,
 *   then emphasis. That second look can pair marks the first could not, because the rule of
 *   three reads what is left of a run, which pairs since have used. Whatever it leaves is read
 *   as written. This is why `*a ~~b* c~~` strikes nothing.
 * - A link's text is paired the same way, on its own, before the paragraph is.
 */

import { attention } from "micromark-core-commonmark";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import type {
  Construct,
  Event,
  Extension,
  Point,
  Resolver,
  Token,
  TokenizeContext,
} from "micromark-util-types";

type Kind = "attention" | "strikethrough";

/** A run of marks, waiting to be paired. */
interface Run {
  kind: Kind;
  /** Where its `enter` event is in the events resolved. */
  at: number;
  token: Token;
  marker: number;
  size: number;
  /** Marks used closing pairs, from its start, and opening them, from its end. */
  left: number;
  right: number;
  open: boolean;
  close: boolean;
  /** Pairs it closes, innermost first, and opens, innermost first. */
  closes: Pair[];
  opens: Pair[];
  /** Done with: what is left of it reads as written. */
  dead: boolean;
  /** Its neighbours among the runs still at its level. */
  prev: Run | null;
  next: Run | null;
}

interface Pair {
  group: Token;
  text: Token;
  /** The marks that open and close it: new tokens for emphasis, the runs' own for strikethrough. */
  opening: Token;
  closing: Token;
}

/**
 * Work done, in steps of the loops below, for markdown.test.tsx to show it grows in step with
 * the text. A count, never a time, so a slow or busy machine can't move it.
 */
export const work = { steps: 0 };

const remaining = (run: Run) => run.size - run.left - run.right;

const moved = (point: Point, by: number): Point => ({
  ...point,
  column: point.column + by,
  offset: point.offset + by,
  _bufferIndex: point._bufferIndex + by,
});

/** A level's runs, first to last, as a list a pair can lift its inside out of. */
function link(runs: Run[]): Run | null {
  for (let i = 0; i < runs.length; i++) {
    runs[i]!.prev = runs[i - 1] ?? null;
    runs[i]!.next = runs[i + 1] ?? null;
  }
  return runs[0] ?? null;
}

/** The runs between an opener and its closer, lifted out of their level. */
function inside(opener: Run, closer: Run): Run[] {
  const out: Run[] = [];
  for (let run = opener.next; run && run !== closer; run = run.next) {
    work.steps++;
    out.push(run);
  }
  opener.next = closer;
  closer.prev = opener;
  return out;
}

/** What micromark does again inside a pair: strikethrough, then emphasis, then the rest is text. */
function span(runs: Run[]) {
  if (!runs.length) return;
  pass("strikethrough", link(runs));
  for (const run of runs) if (run.kind === "strikethrough") run.dead = true;
  pass("attention", link(runs.filter((run) => !run.dead)));
  for (const run of runs) run.dead = true;
}

/** Pair one kind over a level's runs, as micromark's resolver for it walks a list of events. */
function pass(kind: Kind, first: Run | null) {
  const stack: Run[] = [];
  // Below `floor[sort]` nothing on the stack can open a closer of that sort: its marker, whether
  // it may also open, and its length on three, which are all the rule of three reads of it.
  // Strikethrough's sorts are its two lengths.
  const floor = new Array<number>(12).fill(0);
  const sort = (closer: Run) =>
    kind === "strikethrough"
      ? remaining(closer)
      : (closer.marker === 42 ? 0 : 6) + (closer.open ? 3 : 0) + (remaining(closer) % 3);
  const opens = (opener: Run, closer: Run) => {
    if (opener.marker !== closer.marker) return false;
    const size = remaining(closer);
    if (kind === "strikethrough") return remaining(opener) === size;
    // micromark's rule of three, on what is left of each run.
    return !((opener.close || closer.open) && size % 3 && !((remaining(opener) + size) % 3));
  };

  for (let closer = first; closer; closer = closer.next) {
    work.steps++;
    if (closer.kind !== kind) continue;
    while (closer.close && remaining(closer) > 0) {
      const which = sort(closer);
      let at = stack.length - 1;
      for (; at >= floor[which]!; at--) {
        work.steps++;
        if (opens(stack[at]!, closer)) break;
      }
      if (at < floor[which]!) {
        floor[which] = stack.length;
        break;
      }
      const opener = stack[at]!;
      stack.length = at + 1;
      const use =
        kind === "strikethrough"
          ? remaining(closer)
          : remaining(opener) > 1 && remaining(closer) > 1
            ? 2
            : 1;
      const made = pair(kind, opener, closer, use);
      opener.opens.push(made);
      closer.closes.push(made);
      opener.right += use;
      closer.left += use;
      span(inside(opener, closer));
      if (!remaining(opener)) stack.length = at;
      // The opener changed or went, so every sort looks at it again.
      for (let i = 0; i < floor.length; i++) floor[i] = Math.min(floor[i]!, at);
    }
    if (closer.open && remaining(closer) > 0) stack.push(closer);
  }
}

/** The tokens of a pair, as micromark makes them. */
function pair(kind: Kind, opener: Run, closer: Run, use: number): Pair {
  if (kind === "strikethrough") {
    opener.token.type = "strikethroughSequence";
    closer.token.type = "strikethroughSequence";
    return {
      group: {
        type: "strikethrough",
        start: { ...opener.token.start },
        end: { ...closer.token.end },
      },
      text: {
        type: "strikethroughText",
        start: { ...opener.token.end },
        end: { ...closer.token.start },
      },
      opening: opener.token,
      closing: closer.token,
    };
  }
  const strong = use > 1;
  const textStart = moved(opener.token.end, -opener.right);
  const textEnd = moved(closer.token.start, closer.left);
  const opening: Token = {
    type: strong ? "strongSequence" : "emphasisSequence",
    start: moved(textStart, -use),
    end: { ...textStart },
  };
  const closing: Token = {
    type: strong ? "strongSequence" : "emphasisSequence",
    start: { ...textEnd },
    end: moved(textEnd, use),
  };
  return {
    group: {
      type: strong ? "strong" : "emphasis",
      start: { ...opening.start },
      end: { ...closing.end },
    },
    text: { type: strong ? "strongText" : "emphasisText", start: textStart, end: textEnd },
    opening,
    closing,
  };
}

const TEMPORARY = {
  attentionSequence: "attention",
  strikethroughSequenceTemporary: "strikethrough",
} as const satisfies Record<string, Kind>;

function resolver(kind: Kind): Resolver {
  return (events: Event[], context: TokenizeContext): Event[] => {
    const runs: Run[] = [];
    let any = false;
    for (let at = 0; at < events.length; at++) {
      work.steps++;
      const [phase, token] = events[at]!;
      const of = TEMPORARY[token.type as keyof typeof TEMPORARY];
      if (phase !== "enter" || !of) continue;
      any ||= of === kind;
      runs.push({
        kind: of,
        at,
        token,
        marker: context.sliceSerialize(token).charCodeAt(0),
        size: token.end.offset - token.start.offset,
        left: 0,
        right: 0,
        open: Boolean(token._open),
        close: Boolean(token._close),
        closes: [],
        opens: [],
        dead: false,
        prev: null,
        next: null,
      });
    }
    if (!any) return events;
    pass(kind, link(runs));
    // What this kind left at the top reads as written; the other kind's wait for its own turn.
    for (const run of runs) if (run.kind === kind) run.dead = true;

    const out: Event[] = [];
    let next = 0;
    for (const run of runs) {
      work.steps++;
      for (let at = next; at < run.at; at++) out.push(events[at]!);
      next = run.at + 2;
      for (const made of run.closes) {
        out.push(
          ["exit", made.text, context],
          ["enter", made.closing, context],
          ["exit", made.closing, context],
          ["exit", made.group, context],
        );
      }
      if (remaining(run) > 0) {
        if (run.left) run.token.start = moved(run.token.start, run.left);
        if (run.right) run.token.end = moved(run.token.end, -run.right);
        if (run.dead) run.token.type = "data";
        out.push(events[run.at]!, events[run.at + 1]!);
      }
      for (let i = run.opens.length - 1; i >= 0; i--) {
        const made = run.opens[i]!;
        out.push(
          ["enter", made.group, context],
          ["enter", made.opening, context],
          ["exit", made.opening, context],
          ["enter", made.text, context],
        );
      }
    }
    for (let at = next; at < events.length; at++) out.push(events[at]!);
    // In place: micromark reads a text's events back from its tokenizer, not from what this
    // returns.
    work.steps += out.length;
    events.length = 0;
    for (const event of out) events.push(event);
    return events;
  };
}

const strikethrough = gfmStrikethrough().text![126] as Construct;

const linearAttention: Construct = {
  name: "attention",
  tokenize: attention.tokenize,
  resolveAll: resolver("attention"),
};
const linearStrikethrough: Construct = {
  name: "strikethrough",
  tokenize: strikethrough.tokenize,
  resolveAll: resolver("strikethrough"),
};

/**
 * A micromark extension in place of GFM's strikethrough: it and emphasis, paired in linear time.
 * micromark tries an extension's constructs before its own, so its own `attention` never
 * tokenizes anything; it still runs over a link's text, after these, and finds nothing to pair.
 */
export const linearEmphasis: Extension = {
  text: { 42: linearAttention, 95: linearAttention, 126: linearStrikethrough },
  insideSpan: { null: [linearStrikethrough, linearAttention] },
  attentionMarkers: { null: [126] },
};
