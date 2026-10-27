import { expect, test } from "bun:test";
import { type Doc, emptyDoc, parseArtboardFile, type Thread } from "@ponzu/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Canvas } from "./Canvas.tsx";
import { ThreadCard } from "./Comments.tsx";
import { MemorySource } from "./connection.ts";
import { type DraftPin, draftKey, getDraft, setDraft, unsent } from "./drafts.ts";

function doc(): Doc {
  const d = emptyDoc("Kettle");
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="ab_a" data-name="Home" style="width:400px;height:300px"></section>`,
    { id: "ab_a", name: "Home" },
  );
  d.pages.push({ id: "pg_a", name: "Brand", artboards: [artboard] });
  return d;
}

const me = { kind: "user", name: "Sam" } as const;
function thread(status: Thread["status"]): Thread {
  return {
    id: "th_1",
    artboardId: "ab_a",
    x: 10,
    y: 10,
    status,
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: "m_1", author: me, text: "make it blue", createdAt: 1 }],
  };
}

test("a new comment left unsent keeps its pin, until its words are gone", () => {
  const source = new MemorySource(doc());
  const file = source.getState().path;
  const pin: DraftPin = { artboardId: "ab_a", pageId: "pg_a", x: 40, y: 60 };
  const key = draftKey.comment(file, pin);
  expect(renderToStaticMarkup(<Canvas source={source} />)).not.toContain("Unsent comment");
  setDraft(key, { file, pin, text: "tighter" });
  expect(renderToStaticMarkup(<Canvas source={source} />)).toContain('title="Unsent comment"');
  // Read-only, there's nothing to send it with.
  expect(renderToStaticMarkup(<Canvas source={source} readOnly />)).not.toContain("Unsent comment");
  // Another design's draft isn't this one's.
  setDraft(key, { file: "elsewhere", pin, text: "tighter" });
  expect(renderToStaticMarkup(<Canvas source={source} />)).not.toContain("Unsent comment");
  setDraft(key, null);
  expect(getDraft(key)).toBeUndefined();
});

test("a thread opens again with the reply that was being written", () => {
  const source = new MemorySource(doc());
  const key = draftKey.reply("kettle", "th_1");
  setDraft(key, { file: "kettle", thread: "th_1", text: "and the border" });
  const html = renderToStaticMarkup(
    <ThreadCard thread={thread("open")} source={source} me={me} file="kettle" onClose={() => {}} />,
  );
  expect(html).toContain("and the border");
  setDraft(key, null);
});

test("a thread with a reply left unsent is ringed on the canvas", () => {
  const d = doc();
  d.threads.push(thread("open"));
  const source = new MemorySource(d);
  const file = source.getState().path;
  expect(renderToStaticMarkup(<Canvas source={source} />)).not.toContain("Unsent reply");
  const key = draftKey.reply(file, "th_1");
  setDraft(key, { file, thread: "th_1", text: "and the border" });
  expect(renderToStaticMarkup(<Canvas source={source} />)).toContain("Unsent reply");
  setDraft(key, null);
});

test("a thread resolved while it's open offers a reply that reopens it", () => {
  const source = new MemorySource(doc());
  const html = renderToStaticMarkup(
    <ThreadCard thread={thread("resolved")} source={source} me={me} onClose={() => {}} />,
  );
  expect(html).toContain('placeholder="Reply to reopen…"');
  expect(html).toContain('title="Resolved · Reopen"');
});

test("only words count as unsent", () => {
  expect(unsent({ file: "f", text: "  \n" })).toBe(false);
  expect(unsent({ file: "f", text: " a" })).toBe(true);
});
