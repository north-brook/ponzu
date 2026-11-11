import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { repos, workspaces } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import { recordRepoAccess } from "./repo-access.ts";
import {
  claimRepoIdeas,
  getRepoIdeasAccess,
  type IdeasPolicy,
  saveRepoIdeas,
} from "./repo-ideas.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** The API's policy at `now`, with a small allowance so tests can reach it. */
function policy(now: Date, windowLimit = 3): IdeasPolicy {
  return {
    now,
    retryBefore: new Date(now.getTime() - HOUR),
    staleBefore: new Date(now.getTime() - 30 * DAY),
    windowStartedBefore: new Date(now.getTime() - HOUR),
    windowLimit,
    version: 1,
  };
}

const at = (iso: string) => new Date(`2026-11-${iso}Z`);

describe("claimRepoIdeas", () => {
  test("claims a repo once, then not again until the retry interval has passed", async () => {
    const workspace = await seedWorkspace(db);
    const repo = await seedRepo(db, workspace.id, "north-brook/once");
    const now = at("10T12:00:00");

    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(now) })).toBe("claimed");
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(now) })).toBe("not_due");
    const later = new Date(now.getTime() + 30 * 60_000);
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(later) })).toBe("not_due");
    // The try never finished (an instance died): an hour on, it can be taken again.
    const hourOn = new Date(now.getTime() + HOUR);
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(hourOn) })).toBe("claimed");
  });

  test("of claims at the same moment, exactly one wins", async () => {
    const workspace = await seedWorkspace(db);
    const repo = await seedRepo(db, workspace.id, "north-brook/racing");
    const now = at("10T12:00:00");
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimRepoIdeas(db, { repoId: repo.id, ...policy(now, 50) })),
    );
    expect(claims.filter((claim) => claim === "claimed")).toHaveLength(1);
  });

  test("generated ideas are made again only when old and pushed since, or empty and pushed since", async () => {
    const workspace = await seedWorkspace(db);
    const repo = await seedRepo(db, workspace.id, "north-brook/aging");
    const claimedAt = at("01T12:00:00");
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(claimedAt) })).toBe("claimed");
    expect(
      await saveRepoIdeas(db, {
        repoId: repo.id,
        ideas: ["One"],
        generatedAt: claimedAt,
        claimedAt,
        version: 1,
      }),
    ).toBe(true);

    // Forty days on, but nobody pushed: the ideas still describe the repo.
    const fortyDays = new Date(claimedAt.getTime() + 40 * DAY);
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(fortyDays) })).toBe("not_due");
    // A push a week after they were made: not yet old enough to make again.
    await db
      .update(repos)
      .set({ pushedAt: at("08T00:00:00") })
      .where(eq(repos.id, repo.id));
    const tenDays = new Date(claimedAt.getTime() + 10 * DAY);
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(tenDays) })).toBe("not_due");
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(fortyDays) })).toBe("claimed");

    // An empty list is made again after any push.
    const empty = await seedRepo(db, workspace.id, "north-brook/empty");
    const first = at("01T12:00:00");
    await claimRepoIdeas(db, { repoId: empty.id, ...policy(first) });
    await saveRepoIdeas(db, {
      repoId: empty.id,
      ideas: [],
      generatedAt: first,
      claimedAt: first,
      version: 1,
    });
    const twoHours = new Date(first.getTime() + 2 * HOUR);
    expect(await claimRepoIdeas(db, { repoId: empty.id, ...policy(twoHours) })).toBe("not_due");
    await db
      .update(repos)
      .set({ pushedAt: new Date(first.getTime() + HOUR) })
      .where(eq(repos.id, empty.id));
    expect(await claimRepoIdeas(db, { repoId: empty.id, ...policy(twoHours) })).toBe("claimed");
  });

  test("a workspace starts at most its allowance in a window, across its repos", async () => {
    const workspace = await seedWorkspace(db);
    const many = await Promise.all(
      Array.from({ length: 6 }, (_, i) => seedRepo(db, workspace.id, `north-brook/many-${i}`)),
    );
    const now = at("10T12:00:00");
    const claims = await Promise.all(
      many.map((repo) => claimRepoIdeas(db, { repoId: repo.id, ...policy(now, 3) })),
    );
    expect(claims.filter((claim) => claim === "claimed")).toHaveLength(3);
    expect(claims.filter((claim) => claim === "rate_limited")).toHaveLength(3);

    // Another workspace has its own allowance.
    const other = await seedWorkspace(db, "elsewhere");
    const theirs = await seedRepo(db, other.id, "elsewhere/one");
    expect(await claimRepoIdeas(db, { repoId: theirs.id, ...policy(now, 3) })).toBe("claimed");

    // The next window opens an hour after this one began.
    const next = new Date(now.getTime() + HOUR);
    const waiting = many.filter((_, i) => claims[i] === "rate_limited");
    expect(await claimRepoIdeas(db, { repoId: waiting[0]!.id, ...policy(next, 3) })).toBe(
      "claimed",
    );
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(row!.ideasWindowCount).toBe(1);
  });

  test("a repo the App lost is never claimed", async () => {
    const workspace = await seedWorkspace(db);
    const repo = await seedRepo(db, workspace.id, "north-brook/gone");
    await db
      .update(repos)
      .set({ removedAt: at("01T00:00:00") })
      .where(eq(repos.id, repo.id));
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(at("10T12:00:00")) })).toBe(
      "not_due",
    );
  });
  test("an empty list an earlier way of making ideas wrote is due at once, push or not", async () => {
    const workspace = await seedWorkspace(db);
    const repo = await seedRepo(db, workspace.id, "north-brook/skipped");
    const first = at("01T12:00:00");
    await claimRepoIdeas(db, { repoId: repo.id, ...policy(first) });
    // Written before there were versions: the column's default.
    await saveRepoIdeas(db, {
      repoId: repo.id,
      ideas: [],
      generatedAt: first,
      claimedAt: first,
      version: 0,
    });
    const twoHours = new Date(first.getTime() + 2 * HOUR);
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(twoHours) })).toBe("claimed");
    // Once this way has written its own empty list, that one waits for a push.
    await saveRepoIdeas(db, {
      repoId: repo.id,
      ideas: [],
      generatedAt: twoHours,
      claimedAt: twoHours,
      version: 1,
    });
    const later = new Date(twoHours.getTime() + 2 * HOUR);
    expect(await claimRepoIdeas(db, { repoId: repo.id, ...policy(later) })).toBe("not_due");

    // Ideas an earlier way made are kept: only an empty list is made again.
    const kept = await seedRepo(db, workspace.id, "north-brook/kept");
    await claimRepoIdeas(db, { repoId: kept.id, ...policy(first) });
    await saveRepoIdeas(db, {
      repoId: kept.id,
      ideas: ["One"],
      generatedAt: first,
      claimedAt: first,
      version: 0,
    });
    expect(await claimRepoIdeas(db, { repoId: kept.id, ...policy(twoHours) })).toBe("not_due");
  });
});

describe("saveRepoIdeas", () => {
  test("only the latest claim writes", async () => {
    const workspace = await seedWorkspace(db);
    const repo = await seedRepo(db, workspace.id, "north-brook/late");
    const first = at("10T12:00:00");
    await claimRepoIdeas(db, { repoId: repo.id, ...policy(first) });
    const second = new Date(first.getTime() + HOUR);
    await claimRepoIdeas(db, { repoId: repo.id, ...policy(second) });
    expect(
      await saveRepoIdeas(db, {
        repoId: repo.id,
        ideas: ["Late"],
        generatedAt: second,
        claimedAt: first,
        version: 1,
      }),
    ).toBe(false);
    expect(
      await saveRepoIdeas(db, {
        repoId: repo.id,
        ideas: ["On time"],
        generatedAt: second,
        claimedAt: second,
        version: 1,
      }),
    ).toBe(true);
  });
});

describe("getRepoIdeasAccess", () => {
  test("answers the repo, membership and the kept answer for one person", async () => {
    const [user, workspace] = await Promise.all([seedUser(db, "maya"), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id, "north-brook/seen");
    const outsider = await getRepoIdeasAccess(db, { repoId: repo.id, userId: user.id });
    expect(outsider).toMatchObject({ member: false, known: null, repo: { ideas: [] } });

    await upsertMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      githubAccess: "member",
      role: "member",
    });
    const checkedAt = at("10T12:00:00");
    await recordRepoAccess(db, [
      { userId: user.id, repoId: repo.id, permission: "read", checkedAt },
    ]);
    const member = await getRepoIdeasAccess(db, { repoId: repo.id, userId: user.id });
    expect(member).toMatchObject({
      member: true,
      known: { permission: "read", checkedAt },
      installationId: workspace.installationId,
      repo: { id: repo.id, fullName: "north-brook/seen", ideasGeneratedAt: null },
    });
    expect(await getRepoIdeasAccess(db, { repoId: "repo_missing", userId: user.id })).toBeNull();
  });
});
