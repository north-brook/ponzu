import { expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { UpstreamError } from "../http/errors.ts";
import { createGithub } from "./github.ts";

// Reading a repository's contents through Octokit on the API's fetch: what `ideas/read-repo.ts`
// calls.

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

const file = (text: string) =>
  Response.json({
    type: "file",
    size: text.length,
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
  });

test("a tree is every entry GitHub lists, with paths of any characters, and says when it was cut", async () => {
  const entries = [
    { path: "app/{slug}/page.tsx", mode: "100644", type: "blob", sha: "a", size: 120 },
    { path: "app/{slug}", mode: "040000", type: "tree", sha: "b" },
    { path: "vendor/lib", mode: "160000", type: "commit", sha: "c" },
  ];
  const { github, asked } = githubServing(() =>
    Response.json({ sha: "s", tree: entries, truncated: true }),
  );
  const tree = await github.getTree("ghs_token", { fullName: "o/r", ref: "main" });
  expect(tree).toEqual({
    entries: [
      { path: "app/{slug}/page.tsx", type: "blob", size: 120 },
      { path: "app/{slug}", type: "tree", size: null },
    ],
    complete: false,
  });
  expect(asked[0]).toMatchObject({
    url: "https://api.github.com/repos/o/r/git/trees/main?recursive=1",
    authorization: "Bearer ghs_token",
  });
});

test("a file is its text, cut at its budget; a missing or too large one is null; a public read sends no token", async () => {
  const { github, asked } = githubServing((url) =>
    url.includes("missing")
      ? Response.json({ message: "Not Found" }, { status: 404 })
      : url.includes("huge")
        ? Response.json({ type: "file", size: 5_000_000, encoding: "none", content: "" })
        : file("x".repeat(10_000)),
  );
  const text = await github.getFileText(null, {
    fullName: "o/r",
    path: "app/(shop)/page.tsx",
    ref: "main",
    maxBytes: 1_000,
  });
  expect(text).toHaveLength(1_000);
  // Octokit encodes the whole path as one part, which GitHub reads as the same path.
  expect(asked[0]!.url).toBe(
    "https://api.github.com/repos/o/r/contents/app%2F%28shop%29%2Fpage.tsx?ref=main",
  );
  expect(asked[0]!.authorization).toBeNull();
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
    await github.getFileText(null, { fullName: "o/r", path: "huge", ref: "main", maxBytes: 10 }),
  ).toBeNull();
  expect(
    await github.getReadme(null, { fullName: "o/missing", ref: "main", maxBytes: 10 }),
  ).toBeNull();
});

test("GitHub failing is an UpstreamError with its status", async () => {
  const { github } = githubServing(() =>
    Response.json({ message: "Git Repository is empty." }, { status: 409 }),
  );
  const error = await github.getTree(null, { fullName: "o/r", ref: "main" }).catch((e) => e);
  expect(error).toBeInstanceOf(UpstreamError);
  expect(error.status).toBe(409);
});

test("a repository's page: description, topics, default branch and whether it is private", async () => {
  const { github } = githubServing(() =>
    Response.json({
      description: "A plant shop",
      topics: ["plants", 7],
      homepage: "",
      language: "TypeScript",
      default_branch: "trunk",
      archived: false,
      private: true,
    }),
  );
  expect(await github.getRepositoryAbout(null, "o/r")).toEqual({
    description: "A plant shop",
    topics: ["plants"],
    homepage: null,
    language: "TypeScript",
    defaultBranch: "trunk",
    archived: false,
    private: true,
  });
});
