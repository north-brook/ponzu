import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IDEAS_RETRY_MS, type IdeasState, watchRepoIdeas } from "./ideas.ts";
import { useRepoIdeas } from "./react.ts";
import { createFakeBackend } from "./testing/backend.ts";
import { FakeClock } from "./testing/clock.ts";

const IDEAS = [
  "Make checkout one page, with the order summary on the right",
  "Three takes on the home hero that put the plants first",
] as const;

function setup() {
  const clock = new FakeClock();
  const backend = createFakeBackend({ clock });
  const maya = backend.addPerson({ login: "maya" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin" },
    repos: [{ name: "fernwood" }, { name: "secret", access: { [maya.id]: "none" } }],
  });
  const { api } = backend.connect(maya);
  const heard: IdeasState[] = [];
  const watch = (repoId: string) => watchRepoIdeas(api, repoId, (s) => heard.push(s), { clock });
  return { clock, backend, ws, heard, watch, repo: ws.repos[0]!.id };
}

describe("watchRepoIdeas", () => {
  test("loading while they are made, asking again shortly, then the ideas with stable ids", async () => {
    const { clock, backend, heard, watch, repo } = setup();
    backend.setIdeas(repo, "generating", "generating", [...IDEAS]);
    watch(repo);
    await clock.advance(0);
    expect(heard).toEqual(["loading"]);
    await clock.advance(IDEAS_RETRY_MS[0]);
    expect(heard).toEqual(["loading"]);
    await clock.advance(IDEAS_RETRY_MS[1]);
    expect(heard).toEqual([
      "loading",
      [
        { id: `${repo}:0`, prompt: IDEAS[0] },
        { id: `${repo}:1`, prompt: IDEAS[1] },
      ],
    ]);
    expect(clock.pending).toBe(0);
  });

  test("none, an error or a repo they cannot read are all simply no ideas", async () => {
    const { clock, backend, ws, heard, watch, repo } = setup();
    watch(repo);
    await clock.advance(0);
    watch(ws.repos[1]!.id);
    await clock.advance(0);
    backend.online = false;
    watch(repo);
    await clock.advance(0);
    expect(heard).toEqual(["loading", null, "loading", null, "loading", null]);
  });

  test("gives up after about 45 seconds of generating, and stops when told", async () => {
    const { clock, backend, heard, watch, repo } = setup();
    backend.setIdeas(repo, "generating");
    watch(repo);
    const total = IDEAS_RETRY_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(45_000);
    await clock.advance(total);
    expect(heard).toEqual(["loading", null]);

    const later: IdeasState[] = [];
    const stop = watchRepoIdeas(
      { repos: { ideas: async () => ({ status: "generating" as const, ideas: [] }) } },
      repo,
      (s) => later.push(s),
      { clock },
    );
    await clock.advance(1_000);
    stop();
    await clock.advance(60_000);
    expect(later).toEqual(["loading"]);
    expect(clock.pending).toBe(0);
  });
});

test("useRepoIdeas: loading until the repo's first answer, and null for Scratch", () => {
  const { backend, ws } = setup();
  const { api } = backend.connect(backend.addPerson({ login: "ines" }));
  function Ideas({ repoId }: { repoId: string | null }) {
    const ideas = useRepoIdeas(api, repoId);
    return createElement("p", null, JSON.stringify(ideas));
  }
  expect(renderToStaticMarkup(createElement(Ideas, { repoId: ws.repos[0]!.id }))).toBe(
    "<p>&quot;loading&quot;</p>",
  );
  expect(renderToStaticMarkup(createElement(Ideas, { repoId: null }))).toBe("<p>null</p>");
});
