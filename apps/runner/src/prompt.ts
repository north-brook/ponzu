import type { AnswerEvent, Person, RunnerEvent } from "./api/protocol.ts";

/*
 * What the model reads for each event. Every one starts with a line that says what it is and
 * who it is from, then the person's own words as they wrote them. Ids are given whole, as the
 * tools take them, so the agent can act on a thread or an artboard without searching for it.
 */

/** The text an event goes into the session as. `stop` is not one: it interrupts instead. */
export function eventText(event: Exclude<RunnerEvent, { kind: "stop" }>): string {
  const who = name(event.from);
  switch (event.kind) {
    case "message":
      return `Message from ${who}:\n${event.payload.text}`;
    case "comment": {
      const c = event.payload;
      const where = c.artboardId
        ? `on ${quote(c.artboardName)} (artboard ${c.artboardId})`
        : "on the open canvas";
      const pinned = c.nodeId ? `\nIt is pinned to node ${c.nodeId}.` : "";
      return c.reply
        ? `Reply from ${who} in comment thread ${c.threadId} ${where}:\n${c.text}`
        : `Comment from ${who} ${where}, thread ${c.threadId}:\n${c.text}${pinned}`;
    }
    case "answer":
      return answerText(who, event.payload);
    case "edit": {
      const boards = event.payload.artboards.map((a) => `${quote(a.name)} (${a.id})`).join(", ");
      return `Canvas edit by ${who}: ${event.payload.summary}${boards ? `\nArtboards: ${boards}` : ""}`;
    }
    case "check": {
      const c = event.payload;
      return lines(
        `A check failed on the pull request: ${quote(c.name)} (${c.conclusion.replace("_", " ")}).`,
        c.url && `Details: ${c.url}`,
        c.summary,
      );
    }
    case "review": {
      const r = event.payload;
      const verdict = {
        approved: "approved it",
        changes_requested: "asked for changes",
        commented: "left comments",
      }[r.state];
      const notes = r.comments
        ? `, with ${r.comments} line comment${r.comments > 1 ? "s" : ""}`
        : "";
      return lines(
        `Review from ${who} on the pull request: ${verdict}${notes}.`,
        r.url && `Details: ${r.url}`,
        r.body,
      );
    }
  }
}

/**
 * An answer that arrives when nobody is waiting for it, because the run that asked has ended:
 * it goes in as a message, saying what was asked by the words it was answered under.
 */
function answerText(who: string, a: AnswerEvent): string {
  if (a.answers) {
    const said = Object.entries(a.answers).map(([q, answer]) => `${quote(q)}: ${answer}`);
    return [`Answer from ${who} to your question ${a.questionId}:`, ...said].join("\n");
  }
  const verdict = a.approved ? "said yes to" : "said no to";
  return lines(`${who} ${verdict} your request ${a.questionId}.`, a.note);
}

/** What the agent hears when edits it made were undone and no tool result has said so. */
export function noticeText(notices: string[]): string {
  return ["From Ponzu, about your last turn:", ...notices].join("\n\n");
}

function name(person: Person | null): string {
  return person?.name ?? "GitHub";
}

function quote(text: string | null): string {
  return text ? `"${text}"` : "an unnamed artboard";
}

function lines(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p) => p).join("\n");
}
