import { expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { createGithub } from "./github.ts";

// Reading a repository's contents a little at a time: what `ideas/read-repo.ts` calls.

function githubServing(serve: (url: string, init: RequestInit) => Response) {
  const asked: { url: string; authorization: string | null; accept: string | null }[] = [];
  const github = createGithub({
    clientId: "Iv23test",
    clientSecret: "secret",
    privateKey: "",
    clock: new FakeClock(),
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers);
      asked.push({
        url,
        authorization: headers.get("authorization"),
        accept: headers.get("accept"),
      });
      return serve(url, init);
    },
  });
  return { github, asked };
}

test("a tree longer than its budget is read as far as it goes, and never further", async () => {
  const entries = Array.from({ length: 5_000 }, (_, i) => ({
    path: `src/components/Part${i}.tsx`,
    mode: "100644",
    type: "blob",
    sha: "a".repeat(40),
    size: 120,
    url: `https://api.github.com/repos/o/r/git/blobs/${i}`,
  }));
  const body = JSON.stringify({ sha: "b".repeat(40), tree: entries, truncated: false });
  let pulled = 0;
  const { github } = githubServing(() => {
    const bytes = new TextEncoder().encode(body);
    pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(pulled, pulled + 16_384));
        pulled += 16_384;
      },
    });
    return new Response(stream, { headers: { "content-type": "application/json" } });
  });

  const tree = await github.getTree("ghs_token", {
    fullName: "o/r",
    ref: "main",
    maxBytes: 100_000,
  });
  expect(tree.complete).toBe(false);
  expect(tree.entries.length).toBeGreaterThan(300);
  expect(tree.entries.length).toBeLessThan(5_000);
  expect(tree.entries[0]).toEqual({ path: "src/components/Part0.tsx", type: "blob", size: 120 });
  // It stopped pulling once it had enough.
  expect(pulled).toBeLessThan(100_000 + 16_384 * 2);

  const whole = await github.getTree(null, { fullName: "o/r", ref: "main", maxBytes: 10_000_000 });
  expect(whole).toMatchObject({ complete: true });
  expect(whole.entries).toHaveLength(5_000);
});

test("a file is its raw text, cut at its budget; a missing one is null; a public read sends no token", async () => {
  const { github, asked } = githubServing((url) =>
    url.includes("missing")
      ? Response.json({ message: "Not Found" }, { status: 404 })
      : new Response("x".repeat(10_000)),
  );
  const text = await github.getFileText(null, {
    fullName: "o/r",
    path: "app/(shop)/page.tsx",
    ref: "main",
    maxBytes: 1_000,
  });
  expect(text).toHaveLength(1_000);
  expect(asked[0]).toEqual({
    url: "https://api.github.com/repos/o/r/contents/app/(shop)/page.tsx?ref=main",
    authorization: null,
    accept: "application/vnd.github.raw+json",
  });
  expect(
    await github.getFileText("ghs_token", {
      fullName: "o/r",
      path: "missing",
      ref: "main",
      maxBytes: 10,
    }),
  ).toBeNull();
  expect(asked[1]!.authorization).toBe("Bearer ghs_token");
  expect(
    await github.getReadme(null, { fullName: "o/missing", ref: "main", maxBytes: 10 }),
  ).toBeNull();
});

test("a repository's page: description, topics and default branch", async () => {
  const { github } = githubServing(() =>
    Response.json({
      description: "A plant shop",
      topics: ["plants", 7],
      homepage: "",
      language: "TypeScript",
      default_branch: "trunk",
      archived: false,
    }),
  );
  expect(await github.getRepositoryAbout(null, "o/r")).toEqual({
    description: "A plant shop",
    topics: ["plants"],
    homepage: null,
    language: "TypeScript",
    defaultBranch: "trunk",
    archived: false,
  });
});
