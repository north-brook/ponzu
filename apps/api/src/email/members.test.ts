import { afterEach, describe, expect, test } from "bun:test";
import {
  getWorkspaceByInstallation,
  jobs,
  stampAllMembersAnnounced,
  teamEmailWorkspace,
} from "@ponzu/db";
import { renderEmail } from "@ponzu/email";
import { FakeClock, FakeSandboxes } from "@ponzu/sandbox";
import type { MailMessage } from "../deps/mail.ts";
import { reconcileInstallation } from "../github/installations.ts";
import { syncGithub } from "../github/sync.ts";
import { runDueJobs } from "../jobs/run.ts";
import {
  createTestApp,
  type FakeInstallation,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";
import type { EmailConfig } from "./kinds.ts";
import {
  MEMBERS_FLOOR_MS,
  MEMBERS_GATHER_MS,
  MEMBERS_JOB,
  MEMBERS_SPACING_MS,
  membersJobKey,
  noteJoined,
} from "./members.ts";

/*
 * People joined (docs/cloud.md, "Email"): an organisation's admins hear who joined its workspace,
 * rolled up, at most once a day, and never about anyone who was there before email could tell
 * them. Joins are real sign-in syncs against the fake GitHub; jobs run as the minute's cron runs
 * them. Memberships are stamped by the database's own clock, so a test that needs a join at a
 * given moment says so by moving `created_at`.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const opened: TestApp[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

/**
 * An app whose clock starts at the real time, so the database's `now()` (a membership's
 * `created_at`, a new workspace's `members_announced_at`) and the app's clock agree.
 */
async function app({
  mail = true,
  email = {},
}: {
  mail?: boolean;
  email?: Partial<EmailConfig>;
} = {}) {
  const clock = new FakeClock(Math.floor(Date.now() / 1000) * 1000);
  const t = await createTestApp({
    mail,
    environment: "production",
    email,
    shared: { clock, sandboxes: new FakeSandboxes(clock) },
  });
  opened.push(t);
  return t;
}

let nextId = 70_000;
const id = () => nextId++;

interface Org {
  installation: FakeInstallation;
  workspaceId: string;
}

/**
 * An organisation with the App installed, its workspace made, and nobody in it yet. Its owners,
 * members and collaborators are as GitHub says; they join when they sync.
 */
async function org(
  t: TestApp,
  {
    owners = [],
    members = [],
    collaborators = [],
    installer = null,
  }: {
    owners?: SignedInPerson[];
    members?: SignedInPerson[];
    collaborators?: SignedInPerson[];
    installer?: SignedInPerson | null;
  },
): Promise<Org> {
  const everyone = [...owners, ...members, ...collaborators];
  const installation: FakeInstallation = {
    id: id(),
    account: {
      id: id(),
      login: "northbrook",
      type: "Organization",
      name: "Northbrook",
      owners: owners.map((person) => person.github.id),
      members: members.map((person) => person.github.id),
    },
    repositorySelection: "selected",
    repositories: [
      {
        id: id(),
        fullName: "northbrook/app",
        access: Object.fromEntries(everyone.map((person) => [person.github.id, "write" as const])),
      },
    ],
  };
  t.github.installations.push(installation);
  const workspace = await reconcileInstallation(t.deps, installation.id, {
    installedByUserId: installer?.userId ?? null,
  });
  await t.backgroundDone();
  return { installation, workspaceId: workspace!.id };
}

/** People signed in before the App reached them: no workspace yet. */
async function people(t: TestApp, ...logins: string[]): Promise<SignedInPerson[]> {
  const signed: SignedInPerson[] = [];
  for (const login of logins) signed.push(await t.signInAs({ login }));
  return signed;
}

/** The person's sign-in sync: they join every workspace GitHub now shows them. */
async function join(t: TestApp, ...who: SignedInPerson[]) {
  for (const person of who) await syncGithub(t.deps, person.userId);
  await t.backgroundDone();
}

/** Change rows as only a test may. Every value here is an id the app made, or a time. */
async function write(t: TestApp, statement: string) {
  await t.db.execute(statement);
}

/** Say when the person joined, as the database would have stamped it. */
async function joinedAt(t: TestApp, workspaceId: string, person: SignedInPerson, at: number) {
  await write(
    t,
    `update memberships set created_at = '${new Date(at).toISOString()}'
      where workspace_id = '${workspaceId}' and user_id = '${person.userId}'`,
  );
}

async function leave(t: TestApp, workspaceId: string, person: SignedInPerson) {
  await write(
    t,
    `delete from memberships where workspace_id = '${workspaceId}' and user_id = '${person.userId}'`,
  );
}

async function setWindowStart(t: TestApp, workspaceId: string, at: number) {
  await write(
    t,
    `update workspaces set members_announced_at = '${new Date(at).toISOString()}'
      where id = '${workspaceId}'`,
  );
}

/**
 * The workspace as it stood before this test's story: these people were in it already, its
 * window starts at `start`, and nothing about them is waiting to be announced.
 */
async function before(t: TestApp, workspaceId: string, start: number, ...there: SignedInPerson[]) {
  for (const person of there) await joinedAt(t, workspaceId, person, start - DAY);
  await setWindowStart(t, workspaceId, start);
  await write(t, `delete from jobs where kind = '${MEMBERS_JOB}'`);
}

async function windowStart(t: TestApp, workspaceId: string): Promise<number> {
  return (await teamEmailWorkspace(t.db, workspaceId))!.membersAnnouncedAt.getTime();
}

/** Every people-joined job recorded, still waiting or not. */
async function membersJobs(t: TestApp) {
  return (await t.db.select().from(jobs)).filter((job) => job.kind === MEMBERS_JOB);
}

async function waitingMembersJobs(t: TestApp) {
  return (await membersJobs(t)).filter((job) => !job.completedAt && !job.failedAt);
}

/** Move the clock to `at` and run what the minute's cron would. */
async function cronAt(t: TestApp, at: number) {
  if (at > t.clock.now()) t.clock.advance(at - t.clock.now());
  await runDueJobs(t.deps, `test:${crypto.randomUUID()}`);
  await t.backgroundDone();
}

/** Whom the emails went to, by login. */
function recipients(t: TestApp, sent: readonly MailMessage[] = t.mail.sent): string[] {
  return sent.map((message) => message.to.split("@")[0]!).sort();
}

describe("with email off or the kind paused", () => {
  test("RESEND_API_KEY unset: joins record no job and send nothing", async () => {
    const t = await app({ mail: false });
    const [owner, ann, ben] = await people(t, "owner", "ann", "ben");
    await org(t, { owners: [owner!], members: [ann!, ben!] });
    await join(t, owner!, ann!, ben!);
    expect(await membersJobs(t)).toEqual([]);
    await cronAt(t, t.clock.now() + 3 * DAY);
    expect(t.mail.sent).toEqual([]);
    // No email line in the logs either: nothing about this email ran at all.
    const logged = JSON.stringify(t.logs);
    expect(logged).not.toContain('"members_');
    expect(logged).not.toContain('"email_');
  });

  test("team paused: joins record no job", async () => {
    const t = await app({ email: { paused: new Set(["team"]) } });
    const [owner, ann] = await people(t, "owner", "ann");
    await org(t, { owners: [owner!], members: [ann!] });
    await join(t, owner!, ann!);
    expect(await membersJobs(t)).toEqual([]);
  });

  test("a job recorded before the pause closes its window without sending", async () => {
    const t = await app({ email: { paused: new Set(["team"]) } });
    const [owner, ann] = await people(t, "owner", "ann");
    const { workspaceId } = await org(t, { owners: [owner!], members: [ann!] });
    await join(t, owner!, ann!);
    // Recorded while `team` was released.
    const unpaused = {
      ...t.deps,
      config: { ...t.deps.config, email: { ...t.deps.config.email, paused: new Set<never>() } },
    };
    const job = await noteJoined(unpaused, workspaceId);
    expect(job).not.toBeNull();
    const until = job!.runAt.getTime();

    await cronAt(t, until);
    expect(t.mail.sent).toEqual([]);
    expect(await windowStart(t, workspaceId)).toBe(until);
    expect(await waitingMembersJobs(t)).toEqual([]);
    expect(t.logs.some((line) => JSON.stringify(line).includes("email_paused"))).toBe(true);
  });
});

describe("who hears, and about whom", () => {
  test("three joins within the hour are one email to each admin, listing all three", async () => {
    const t = await app();
    const [owner, admin2, ann, ben, cat, outsider, promoted, installer, quiet] = await people(
      t,
      "owner",
      "dana",
      "ann",
      "ben",
      "cat",
      "outsider",
      "promoted",
      "installer",
      "quiet",
    );
    const { workspaceId } = await org(t, {
      owners: [owner!, admin2!, quiet!],
      members: [ann!, ben!, cat!, installer!],
      collaborators: [outsider!, promoted!],
      installer: installer!,
    });
    // Everyone already in the workspace before the window opened is not news.
    await join(t, owner!, admin2!, quiet!, promoted!);
    const start = t.clock.now() - 2 * DAY;
    await before(t, workspaceId, start, owner!, admin2!, quiet!, promoted!);
    // An outside collaborator made an admin in Ponzu, and an admin who turned the email off.
    await write(t, `update memberships set role = 'admin' where user_id = '${promoted!.userId}'`);
    await write(t, `update users set email_team = false where id = '${quiet!.userId}'`);

    await join(t, ann!);
    const [first] = await waitingMembersJobs(t);
    const until = first!.runAt.getTime();
    expect(until).toBe(t.clock.now() + MEMBERS_GATHER_MS);
    expect(first!.key).toBe(membersJobKey(workspaceId, new Date(start)));

    t.clock.advance(20 * 60_000);
    await join(t, ben!);
    t.clock.advance(20 * 60_000);
    await join(t, cat!, outsider!, installer!);
    // They folded into the first: one job, due when the first said.
    expect((await waitingMembersJobs(t)).map((job) => job.id)).toEqual([first!.id]);
    for (const [person, minutes] of [
      [ann!, 0],
      [ben!, 20],
      [cat!, 40],
    ] as const) {
      await joinedAt(t, workspaceId, person, until - MEMBERS_GATHER_MS + minutes * 60_000);
    }

    await cronAt(t, until - 1);
    expect(t.mail.sent).toEqual([]);
    await cronAt(t, until);

    // The admins who reach the organisation and want it (the owners, and the installer, made an
    // admin when they joined); never the joiners, the collaborator made admin, the outsider, or
    // the admin who turned it off.
    expect(recipients(t)).toEqual(["dana", "installer", "owner"]);
    const [email] = t.mail.sent;
    expect(email!.subject).toBe("Ann, Ben and Cat joined Northbrook on Ponzu");
    // Three owners (owner, Dana, Quiet) and three members (Ann, Ben, Cat) by `until`, and the
    // installer, who is a member too; the collaborators are not counted.
    expect(email!.text).toContain("Northbrook now has 7 people on Ponzu.");
    expect(email!.text).not.toContain("Outsider");
    expect(email!.text).not.toContain("@installer");
    expect(email!.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(email!.headers["List-Unsubscribe"]).toContain("/v1/email/unsubscribe?t=");
    expect(email!.idempotencyKey).toMatch(
      new RegExp(`^members/${workspaceId}/${new Date(until).toISOString()}/usr_`),
    );
    expect(await windowStart(t, workspaceId)).toBe(until);
    // Nothing joined after the window: nothing more is scheduled.
    expect(await waitingMembersJobs(t)).toEqual([]);
    // Logs carry no address, subject or name.
    const logged = JSON.stringify(t.logs);
    for (const leak of ["@example.com", "joined Northbrook", "Ann"]) {
      expect(logged).not.toContain(leak);
    }
  });

  test("a personal workspace never announces anyone", async () => {
    const t = await app();
    const [maya, friend] = await people(t, "maya", "friend");
    const installation: FakeInstallation = {
      id: id(),
      account: { id: maya!.github.id, login: "maya", type: "User" },
      repositorySelection: "all",
      repositories: [
        {
          id: id(),
          fullName: "maya/site",
          access: { [maya!.github.id]: "write", [friend!.github.id]: "write" },
        },
      ],
    };
    t.github.installations.push(installation);
    await join(t, maya!, friend!);
    const workspace = await getWorkspaceByInstallation(t.db, installation.id);
    expect(workspace?.kind).toBe("personal");
    expect(await membersJobs(t)).toEqual([]);
    expect(await noteJoined(t.deps, workspace!.id)).toBeNull();
  });

  test("everyone already there at migration time stays unannounced, weeks later", async () => {
    const t = await app();
    const [owner, old1, old2, old3, fresh] = await people(
      t,
      "owner",
      "old1",
      "old2",
      "old3",
      "new",
    );
    const { workspaceId } = await org(t, {
      owners: [owner!],
      members: [old1!, old2!, old3!, fresh!],
    });
    // The migration ran 30 days ago, with the owner and one member already in. Two more
    // joined while email was off: one weeks ago, one three days ago.
    await join(t, owner!, old1!, old2!, old3!);
    const migrated = t.clock.now() - 30 * DAY;
    await before(t, workspaceId, migrated, owner!, old1!);
    await joinedAt(t, workspaceId, old2!, migrated + 10 * DAY);
    await joinedAt(t, workspaceId, old3!, t.clock.now() - 3 * DAY);

    // Email is on now, and one person signs in.
    await join(t, fresh!);
    const [job] = await waitingMembersJobs(t);
    await cronAt(t, job!.runAt.getTime());

    expect(recipients(t)).toEqual(["owner"]);
    expect(t.mail.sent[0]!.subject).toBe("New joined Northbrook on Ponzu");
    expect(t.mail.sent[0]!.text).toContain("Northbrook now has 5 people on Ponzu.");
    expect(t.mail.sent[0]!.text).not.toContain("Old");
  });

  test("a join two hours after an email waits until a day after it", async () => {
    const t = await app();
    const [owner, ann, ben] = await people(t, "owner", "ann", "ben");
    const { workspaceId } = await org(t, { owners: [owner!], members: [ann!, ben!] });
    await join(t, owner!);
    await before(t, workspaceId, t.clock.now() - 2 * DAY, owner!);
    await join(t, ann!);
    const [first] = await waitingMembersJobs(t);
    const until = first!.runAt.getTime();
    await cronAt(t, until);
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ann joined Northbrook on Ponzu",
    ]);

    t.clock.advance(2 * HOUR);
    await join(t, ben!);
    await joinedAt(t, workspaceId, ben!, t.clock.now());
    const [second] = await waitingMembersJobs(t);
    expect(second!.runAt.getTime()).toBe(until + MEMBERS_SPACING_MS);
    expect(second!.key).toBe(membersJobKey(workspaceId, new Date(until)));

    await cronAt(t, until + MEMBERS_SPACING_MS - 1);
    expect(t.mail.sent).toHaveLength(1);
    await cronAt(t, until + MEMBERS_SPACING_MS);
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ann joined Northbrook on Ponzu",
      "Ben joined Northbrook on Ponzu",
    ]);
  });

  test("a join that lands while the job runs, after its window, is the next email's", async () => {
    const t = await app();
    const [owner, ann, ben] = await people(t, "owner", "ann", "ben");
    const { workspaceId } = await org(t, { owners: [owner!], members: [ann!, ben!] });
    await join(t, owner!);
    await before(t, workspaceId, t.clock.now() - 2 * DAY, owner!);
    await join(t, ann!);
    const [first] = await waitingMembersJobs(t);
    const until = first!.runAt.getTime();

    // The job is due and not yet done: Ben's join folds into it (nothing new is recorded) but
    // lands after its window closed.
    t.clock.advance(until - t.clock.now() + 60_000);
    await join(t, ben!);
    await joinedAt(t, workspaceId, ben!, until + 30_000);
    expect((await waitingMembersJobs(t)).map((job) => job.id)).toEqual([first!.id]);

    await cronAt(t, t.clock.now());
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ann joined Northbrook on Ponzu",
    ]);
    // The next, for Ben, a day after the first's window closed.
    const [next] = await waitingMembersJobs(t);
    expect(next!.runAt.getTime()).toBe(until + MEMBERS_SPACING_MS);

    await cronAt(t, until + MEMBERS_SPACING_MS);
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ann joined Northbrook on Ponzu",
      "Ben joined Northbrook on Ponzu",
    ]);
    expect(await waitingMembersJobs(t)).toEqual([]);
  });

  test("someone who joins and leaves before the email is not listed; one who comes back is", async () => {
    const t = await app();
    const [owner, ann, ben] = await people(t, "owner", "ann", "ben");
    const { workspaceId } = await org(t, { owners: [owner!], members: [ann!, ben!] });
    await join(t, owner!);
    await before(t, workspaceId, t.clock.now() - 2 * DAY, owner!);
    await join(t, ann!, ben!);
    await leave(t, workspaceId, ben!);
    const [first] = await waitingMembersJobs(t);
    const until = first!.runAt.getTime();
    await cronAt(t, until);
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ann joined Northbrook on Ponzu",
    ]);

    // Ben's access comes back days later: a new membership, announced again.
    t.clock.advance(3 * DAY);
    await join(t, ben!);
    await joinedAt(t, workspaceId, ben!, t.clock.now());
    const [again] = await waitingMembersJobs(t);
    await cronAt(t, again!.runAt.getTime());
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ann joined Northbrook on Ponzu",
      "Ben joined Northbrook on Ponzu",
    ]);
  });

  test("a window whose joiners all left stamps and sends nothing", async () => {
    const t = await app();
    const [owner, ann] = await people(t, "owner", "ann");
    const { workspaceId } = await org(t, { owners: [owner!], members: [ann!] });
    await join(t, owner!);
    await before(t, workspaceId, t.clock.now() - 2 * DAY, owner!);
    await join(t, ann!);
    await leave(t, workspaceId, ann!);
    const [job] = await waitingMembersJobs(t);
    await cronAt(t, job!.runAt.getTime());
    expect(t.mail.sent).toEqual([]);
    expect(await windowStart(t, workspaceId)).toBe(job!.runAt.getTime());
  });

  test("the window never reaches back more than 48 hours before it closes", async () => {
    const t = await app();
    const [owner, early, ann] = await people(t, "owner", "early", "ann");
    const { workspaceId } = await org(t, { owners: [owner!], members: [early!, ann!] });
    await join(t, owner!, early!);
    // The window's start is old (the migration), and Early joined after it but long ago.
    await before(t, workspaceId, t.clock.now() - 10 * DAY, owner!);
    await joinedAt(t, workspaceId, early!, t.clock.now() - MEMBERS_FLOOR_MS);
    await join(t, ann!);
    const [job] = await waitingMembersJobs(t);
    await cronAt(t, job!.runAt.getTime());
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ann joined Northbrook on Ponzu",
    ]);
  });
});

describe("going once", () => {
  test("Resend busy on the second admin: the job goes again and each admin gets one email", async () => {
    const t = await app();
    const [owner, dana, ann] = await people(t, "owner", "dana", "ann");
    const { workspaceId } = await org(t, { owners: [owner!, dana!], members: [ann!] });
    await join(t, owner!, dana!);
    await before(t, workspaceId, t.clock.now() - 2 * DAY, owner!, dana!);
    await join(t, ann!);
    const [job] = await waitingMembersJobs(t);
    const until = job!.runAt.getTime();

    // The first admin's email goes; Resend answers 429 for the second.
    const sendOnce = t.mail.send.bind(t.mail);
    let calls = 0;
    t.mail.send = async (message) => {
      calls += 1;
      if (calls === 2) t.mail.failNext("rate_limited");
      return sendOnce(message);
    };
    await cronAt(t, until);
    expect(t.mail.sent).toHaveLength(1);
    // Not done: the window is still open, and the same job waits five minutes.
    expect(await windowStart(t, workspaceId)).not.toBe(until);
    const [retry] = await waitingMembersJobs(t);
    expect(retry!.id).toBe(job!.id);

    await cronAt(t, t.clock.now() + 5 * 60_000);
    expect(recipients(t)).toEqual(["dana", "owner"]);
    expect(await windowStart(t, workspaceId)).toBe(until);
    // Once done, running the window's job again sends nothing.
    await cronAt(t, t.clock.now() + DAY);
    expect(t.mail.sent).toHaveLength(2);
  });

  test("the stamp at first release only ever moves a window later", async () => {
    const t = await app();
    const [owner] = await people(t, "owner");
    const { workspaceId } = await org(t, { owners: [owner!] });
    const later = t.clock.now() + DAY;
    await setWindowStart(t, workspaceId, later);
    // Run with a clock behind the window: nothing moves back.
    await stampAllMembersAnnounced(t.db, { now: new Date(t.clock.now()) });
    expect(await windowStart(t, workspaceId)).toBe(later);
    await stampAllMembersAnnounced(t.db, { now: new Date(later + HOUR) });
    expect(await windowStart(t, workspaceId)).toBe(later + HOUR);
  });

  test("the same people render the same bytes", async () => {
    const props = {
      workspaceName: "Northbrook",
      people: [
        { name: "Ann Lee", login: "ann" },
        { name: null, login: "ben" },
      ],
      total: 4,
      unsubscribeUrl: "https://api.ponzu.design/v1/email/unsubscribe?t=x",
    };
    expect(await renderEmail("team", props)).toEqual(await renderEmail("team", props));
  });

  test("the stamp at first release drops what joined before it, and a waiting job sends nothing", async () => {
    const t = await app();
    const [owner, ann, ben] = await people(t, "owner", "ann", "ben");
    const { workspaceId } = await org(t, { owners: [owner!], members: [ann!, ben!] });
    await join(t, owner!);
    await before(t, workspaceId, t.clock.now() - 2 * DAY, owner!);
    await join(t, ann!);
    const [stale] = await waitingMembersJobs(t);

    // The founder's stamp runs just before `team` is released.
    t.clock.advance(10 * 60_000);
    expect(await stampAllMembersAnnounced(t.db, { now: new Date(t.clock.now()) })).toBeGreaterThan(
      0,
    );
    // Ben joins after it.
    t.clock.advance(10 * 60_000);
    await join(t, ben!);
    await joinedAt(t, workspaceId, ben!, t.clock.now());

    await cronAt(t, stale!.runAt.getTime());
    expect(t.mail.sent).toEqual([]);
    // Ben is the next email's, a day after the stamp.
    const [next] = await waitingMembersJobs(t);
    expect(next!.id).not.toBe(stale!.id);
    await cronAt(t, next!.runAt.getTime());
    expect(t.mail.sent.map((message) => message.subject)).toEqual([
      "Ben joined Northbrook on Ponzu",
    ]);
  });
});
