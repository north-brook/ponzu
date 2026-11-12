import { describe, expect, test } from "bun:test";
import type { RepoPermission } from "@ponzu/db/types";
import {
  ACCESS_KEPT_MS,
  billingRecipients,
  type CanvasFacts,
  canRead,
  canSteer,
  commentRecipients,
  needsYouRecipients,
  type PersonAccess,
  personRecipients,
  prRecipients,
} from "./recipients.ts";

const now = new Date("2026-11-10T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

function person(
  userId: string,
  permission: RepoPermission | null,
  over: Partial<PersonAccess> = {},
): PersonAccess {
  return { userId, member: true, permission, checkedAt: ago(60_000), ...over };
}

function canvas(people: PersonAccess[], over: Partial<CanvasFacts> = {}): CanvasFacts {
  return {
    ownerId: "owner",
    scratch: false,
    people: new Map(people.map((p) => [p.userId, p])),
    ...over,
  };
}

const team = canvas([
  person("owner", "admin"),
  person("driver", "write"),
  person("writer", "write"),
  person("reader", "read"),
  person("stranger", "none"),
  person("unopened", "write"),
]);
const everyone = new Set(["owner", "driver", "writer", "reader", "stranger"]);

describe("access, from kept answers", () => {
  test("write or admin steers; read reads; none does neither", () => {
    expect(canSteer(team, "owner", now)).toBe(true);
    expect(canSteer(team, "writer", now)).toBe(true);
    expect(canSteer(team, "reader", now)).toBe(false);
    expect(canRead(team, "reader", now)).toBe(true);
    expect(canRead(team, "stranger", now)).toBe(false);
    expect(canRead(team, "nobody", now)).toBe(false);
  });

  test("an answer counts up to 24 hours old, not a millisecond more", () => {
    const at = (age: number) => canvas([person("owner", "write", { checkedAt: ago(age) })]);
    expect(canSteer(at(ACCESS_KEPT_MS), "owner", now)).toBe(true);
    expect(canSteer(at(ACCESS_KEPT_MS + 1), "owner", now)).toBe(false);
  });

  test("a stale answer (checked_at at the epoch) counts as no", () => {
    const stale = canvas([person("owner", "admin", { checkedAt: new Date(0) })]);
    expect(canRead(stale, "owner", now)).toBe(false);
  });

  test("someone who left the workspace can do nothing, whatever the answer", () => {
    const left = canvas([person("owner", "admin", { member: false })]);
    expect(canRead(left, "owner", now)).toBe(false);
  });

  test("a Scratch canvas is its owner's alone", () => {
    const scratch = canvas([person("writer", "write")], { scratch: true });
    expect(canSteer(scratch, "owner", now)).toBe(true);
    expect(canRead(scratch, "writer", now)).toBe(false);
  });
});

describe("needs you", () => {
  test("at once: the owner first, then whoever is driving", () => {
    expect(
      needsYouRecipients(team, { stage: "now", driverId: "driver", openedBy: everyone }, now),
    ).toEqual(["owner", "driver"]);
  });

  test("the owner driving is told once", () => {
    expect(
      needsYouRecipients(team, { stage: "now", driverId: "owner", openedBy: everyone }, now),
    ).toEqual(["owner"]);
  });

  test("a driver who can only read is not asked", () => {
    expect(
      needsYouRecipients(team, { stage: "now", driverId: "reader", openedBy: everyone }, now),
    ).toEqual(["owner"]);
  });

  test("after five minutes: the other steerers who have opened it", () => {
    expect(
      needsYouRecipients(team, { stage: "escalate", driverId: "driver", openedBy: everyone }, now),
    ).toEqual(["writer"]);
  });

  test("an owner who lost access is skipped, and not escalated to either", () => {
    const lost = canvas([person("owner", "read"), person("writer", "write")]);
    expect(
      needsYouRecipients(lost, { stage: "now", driverId: null, openedBy: everyone }, now),
    ).toEqual([]);
    expect(
      needsYouRecipients(lost, { stage: "escalate", driverId: null, openedBy: everyone }, now),
    ).toEqual(["writer"]);
  });
});

describe("the others", () => {
  test("a reply or a turn goes to its person if they can still read", () => {
    expect(personRecipients(team, { personId: "reader" }, now)).toEqual(["reader"]);
    expect(personRecipients(team, { personId: "stranger" }, now)).toEqual([]);
    expect(personRecipients(team, { personId: null }, now)).toEqual([]);
  });

  test("a pull request: the owner and its author, never the reviewer", () => {
    expect(prRecipients(team, { authorId: "writer" }, now)).toEqual(["owner", "writer"]);
    expect(prRecipients(team, { authorId: "writer", actorId: "writer" }, now)).toEqual(["owner"]);
    expect(prRecipients(team, { authorId: null, actorId: "owner" }, now)).toEqual([]);
    expect(prRecipients(team, { authorId: "owner" }, now)).toEqual(["owner"]);
  });

  test("a teammate's comment: the owner, never for their own", () => {
    expect(commentRecipients(team, { authorId: "writer" }, now)).toEqual(["owner"]);
    expect(commentRecipients(team, { authorId: "owner" }, now)).toEqual([]);
  });

  test("billing: a team's admins; a personal workspace's person", () => {
    const members = [
      { userId: "a", role: "admin" as const },
      { userId: "b", role: "member" as const },
      { userId: "c", role: "admin" as const },
    ];
    expect(billingRecipients({ kind: "org", members })).toEqual(["a", "c"]);
    expect(
      billingRecipients({ kind: "personal", members: [{ userId: "p", role: "admin" }] }),
    ).toEqual(["p"]);
  });

  test("never the actor, in any of them", () => {
    expect(
      needsYouRecipients(
        team,
        { stage: "now", driverId: "driver", openedBy: everyone, actorId: "owner" },
        now,
      ),
    ).toEqual(["driver"]);
    expect(personRecipients(team, { personId: "reader", actorId: "reader" }, now)).toEqual([]);
  });
});
