// `bun scripts/ideas.ts owner/repo …`: the ideas for real repositories, made the way the API
// makes them (the same read, prompt, model and checks), printed with what they cost. Nothing
// is stored. For working on the prompt: read what comes out as a designer would.
//
// A public repository is read without a token. One named with `--app` is read as the GitHub
// App, with a token for it alone (GITHUB_APP_CLIENT_ID, GITHUB_APP_PRIVATE_KEY or its _PATH,
// GITHUB_APP_INSTALLATION_ID). The model is paid for with ANTHROPIC_API_KEY.
//
// GitHub's answers are kept in .context/ideas/ at the repository root, so asking again costs
// GitHub nothing; `--fresh` reads again. `--show` prints the prompt. It stops before
// spending more than PONZU_IDEAS_SPEND_USD (default 0.50).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "@ponzu/sandbox";
import { createGithub } from "../src/deps/github.ts";
import { createAnthropicModel } from "../src/deps/model.ts";
import { askForIdeas, type Tally } from "../src/ideas/ideas.ts";
import { ideasPrompt } from "../src/ideas/prompt.ts";
import { readRepository } from "../src/ideas/read-repo.ts";
import { isEmpty, type RepoSnapshot } from "../src/ideas/snapshot.ts";

/** Claude Haiku 5.5's price per million tokens, for prompts under 100K tokens. */
const PRICE = { input: 0.1, output: 0.5 };

const { env } = process;
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
// `test` stands for the dev App's test repository, GITHUB_TEST_REPO, read as the App.
const names = args
  .filter((arg) => !arg.startsWith("--"))
  .map((name) => (name === "test" ? (env.GITHUB_TEST_REPO ?? name) : name));
if (args.includes("test")) flags.add("--app");
const ceiling = Number(env.PONZU_IDEAS_SPEND_USD ?? 0.5);
if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
if (names.length === 0) throw new Error("Name a repository: bun scripts/ideas.ts owner/repo");

const cache = join(import.meta.dir, "../../../.context/ideas");
mkdirSync(cache, { recursive: true });

const github = createGithub({
  clientId: env.GITHUB_APP_CLIENT_ID ?? "",
  clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
  privateKey:
    env.GITHUB_APP_PRIVATE_KEY ??
    (env.GITHUB_APP_PRIVATE_KEY_PATH ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8") : ""),
  fetch: (url, init) => fetch(url, init),
  clock: systemClock,
});
const model = createAnthropicModel({ apiKey: env.ANTHROPIC_API_KEY, fetch: (u, i) => fetch(u, i) });

/** A token for this one repository, as the App, to read it with: what the API mints. */
async function appToken(fullName: string): Promise<string> {
  const installationId = Number(env.GITHUB_APP_INSTALLATION_ID);
  const lookup = await github.createInstallationToken({
    installationId,
    permissions: { metadata: "read" },
  });
  const { items } = await github.listRepositoriesAsInstallation(lookup.token);
  const repository = items.find((item) => item.fullName === fullName);
  if (!repository) throw new Error(`The App cannot see ${fullName}.`);
  const { token } = await github.createInstallationToken({
    installationId,
    repositoryIds: [repository.id],
    permissions: { contents: "read", metadata: "read" },
  });
  return token;
}

/**
 * GitHub's answers, kept: each read is asked once, so changing how a snapshot is made costs no
 * requests (an unauthenticated reader has 60 an hour). `--fresh` asks again.
 */
function kept<A extends unknown[], R>(name: string, read: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    const key = JSON.stringify([name, ...args.slice(1)])
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 180);
    const file = join(cache, `${key}.json`);
    if (!flags.has("--fresh")) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as R;
      } catch {}
    }
    const value = await read(...args);
    writeFileSync(file, JSON.stringify(value));
    return value;
  };
}
const reader = {
  getRepositoryAbout: kept("about", github.getRepositoryAbout),
  getTree: kept("tree", github.getTree),
  getFileText: kept("file", github.getFileText),
  getReadme: kept("readme", github.getReadme),
};

async function snapshotOf(fullName: string): Promise<RepoSnapshot> {
  const token = flags.has("--app") ? await appToken(fullName) : null;
  return readRepository(reader, token, fullName);
}

let spent = 0;
for (const fullName of names) {
  let snapshot: RepoSnapshot;
  try {
    snapshot = await snapshotOf(fullName);
  } catch (error) {
    console.log(`\n## ${fullName}\nThe read failed: ${(error as Error).message}`);
    continue;
  }
  const prompt = ideasPrompt(snapshot);
  console.log(`\n## ${fullName}  (${prompt.length} characters of prompt, ${snapshot.files} files)`);
  if (flags.has("--show")) console.log(prompt);
  if (isEmpty(snapshot)) {
    console.log("Nothing to ground ideas in: none, and no model call.");
    continue;
  }
  if (spent >= ceiling) throw new Error(`Stopped at $${spent.toFixed(4)}, the ceiling.`);
  const started = Date.now();
  const tally: Tally = { attempts: 0, usage: { input: 0, output: 0 } };
  const asked = await askForIdeas(model, prompt, { tally });
  const { input, output } = tally.usage;
  const cost = (input * PRICE.input + output * PRICE.output) / 1_000_000;
  spent += cost;
  console.log(
    `${tally.attempts} ask(s): ${input} in, ${output} out, $${cost.toFixed(5)}, ${Date.now() - started} ms`,
  );
  if ("rejected" in asked) console.log(`None kept: ${asked.rejected}.`);
  else for (const idea of asked.ideas) console.log(`- ${idea}  (${idea.length})`);
}
console.log(`\nSpent $${spent.toFixed(5)} in all.`);
