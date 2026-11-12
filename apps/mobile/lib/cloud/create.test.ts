import { describe, expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import type { Repo } from "@ponzu/client/model";
import {
  blockedOnSend,
  canSend,
  choiceKey,
  firstSentence,
  modelChoice,
  orderShelves,
  pickerGroups,
  projectName,
  readModelChoice,
  resetTime,
  type Shelf,
  sendFailure,
  startingProject,
  statement,
  stillOffered,
} from "./create";

const repo = (owner: string, name: string): Repo => ({ id: `rep_${name}`, owner, name });
const site = repo("acme", "site");
const app = repo("acme", "app");
const brand = repo("north", "brand");

const acme: Shelf = { workspaceId: "ws_acme", kind: "org", name: "Acme", repos: [site, app] };
const mine: Shelf = { workspaceId: "ws_maya", kind: "personal", name: "Personal", repos: [] };
const north: Shelf = { workspaceId: "ws_north", kind: "org", name: "Northbrook", repos: null };

describe("the statement", () => {
  test("in a repo, from scratch, and while the project is found", () => {
    expect(statement({ kind: "repo", repo: site })).toEqual({
      lead: "Make something in",
      place: "acme/site",
    });
    expect(statement({ kind: "scratch" })).toEqual({
      lead: "Make something from",
      place: "scratch",
    });
    expect(statement(null)).toEqual({ lead: "Make something in", place: null });
  });

  test("VoiceOver hears whose Scratch it is", () => {
    expect(projectName({ kind: "scratch" }, "Acme")).toBe("Project: Scratch in Acme");
    expect(projectName({ kind: "repo", repo: site }, "Acme")).toBe("Project: acme/site");
    expect(projectName(null, "Acme")).toBe("Project");
  });
});

describe("the project a canvas starts in", () => {
  test("the repo pushed to last, else Scratch, and nothing while the repos load", () => {
    expect(startingProject([site, app])).toEqual({ kind: "repo", repo: site });
    expect(startingProject([])).toEqual({ kind: "scratch" });
    expect(startingProject(null)).toBeNull();
  });

  test("a pick holds while it is still offered", () => {
    const picked = { kind: "repo", repo: app } as const;
    expect(stillOffered(picked, [site, app])).toEqual(picked);
    expect(stillOffered(picked, [site])).toEqual({ kind: "repo", repo: site });
    expect(stillOffered(picked, null)).toEqual(picked);
    expect(stillOffered({ kind: "scratch" }, [site])).toEqual({ kind: "scratch" });
    expect(stillOffered(null, [app])).toEqual({ kind: "repo", repo: app });
  });
});

test("a prompt goes once it says something, and not while one is going", () => {
  expect(canSend("", false)).toBe(false);
  expect(canSend("   \n ", false)).toBe(false);
  expect(canSend("A pricing page", false)).toBe(true);
  expect(canSend("A pricing page", true)).toBe(false);
});

describe("the picker", () => {
  test("the person's own workspace first, then the others as given", () => {
    expect(orderShelves([acme, north, mine]).map((s) => s.workspaceId)).toEqual([
      "ws_maya",
      "ws_acme",
      "ws_north",
    ]);
  });

  test("each workspace's Scratch, then its repos, under its name", () => {
    expect(pickerGroups([acme, mine, north], "")).toEqual([
      { workspaceId: "ws_maya", heading: "Personal", scratch: true, repos: [], loading: false },
      {
        workspaceId: "ws_acme",
        heading: "Acme",
        scratch: true,
        repos: [site, app],
        loading: false,
      },
      { workspaceId: "ws_north", heading: "Northbrook", scratch: true, repos: [], loading: true },
    ]);
  });

  test("one workspace has no heading", () => {
    expect(pickerGroups([acme], "")).toEqual([
      { workspaceId: "ws_acme", heading: null, scratch: true, repos: [site, app], loading: false },
    ]);
  });

  test("a search finds repos by full name, Scratch by its name, a group by its workspace's", () => {
    const shelves = [acme, mine, { ...north, repos: [brand] }];
    expect(pickerGroups(shelves, "sit").map((g) => [g.workspaceId, g.scratch, g.repos])).toEqual([
      ["ws_acme", false, [site]],
    ]);
    expect(pickerGroups(shelves, "scratch").map((g) => [g.workspaceId, g.repos.length])).toEqual([
      ["ws_maya", 0],
      ["ws_acme", 0],
      ["ws_north", 0],
    ]);
    expect(pickerGroups(shelves, "north").map((g) => [g.workspaceId, g.scratch, g.repos])).toEqual([
      ["ws_north", true, [brand]],
    ]);
    expect(pickerGroups(shelves, "nothing like it")).toEqual([]);
  });

  test("a repo two workspaces share is listed once", () => {
    const twice: Shelf = { ...north, repos: [site] };
    expect(pickerGroups([acme, twice], "").map((g) => g.repos)).toEqual([[site, app], []]);
  });

  test("each Scratch has its own key", () => {
    expect(choiceKey({ kind: "scratch" }, "ws_acme")).toBe("scratch:ws_acme");
    expect(choiceKey({ kind: "repo", repo: site }, "ws_acme")).toBe("rep_site");
  });
});

describe("the model and effort", () => {
  const defaults = {
    model: "claude-opus-5-5",
    effort: "medium" as const,
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high"] as const },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: [] as const },
    ],
    efforts: ["low", "medium", "high"] as const,
  };

  test("the last picked while offered, else the defaults, and nothing before they come", () => {
    expect(modelChoice({ model: "claude-opus-5-5", effort: "high" }, defaults)).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(modelChoice({ model: "claude-gone", effort: "high" }, defaults)).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
    });
    expect(modelChoice({ model: "claude-opus-5-5", effort: "max" }, defaults)).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
    });
    // A model that takes no effort carries one all the same.
    expect(modelChoice({ model: "claude-haiku-5-5", effort: "max" }, defaults)).toEqual({
      model: "claude-haiku-5-5",
      effort: "max",
    });
    expect(modelChoice(null, defaults)).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(modelChoice(null, undefined)).toBeNull();
  });

  test("a kept choice is read back only when whole", () => {
    expect(readModelChoice('{"model":"claude-opus-5-5","effort":"high"}')).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(readModelChoice('{"model":"claude-opus-5-5","effort":"loud"}')).toBeNull();
    expect(readModelChoice("not json")).toBeNull();
    expect(readModelChoice(null)).toBeNull();
  });
});

describe("what stops a send", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const connected = { status: "connected", limitedUntil: null };

  test("a Claude never connected, run out, or signed out", () => {
    expect(blockedOnSend({ claudeAccount: null }, now)).toEqual({
      kind: "claude",
      connected: false,
      expired: false,
    });
    expect(blockedOnSend({ claudeAccount: { status: "expired" } }, now)).toEqual({
      kind: "claude",
      connected: true,
      expired: true,
    });
    expect(blockedOnSend(undefined, now)).toMatchObject({ kind: "claude" });
  });

  test("a plan at its limit until later, and not once that has passed", () => {
    const until = "2026-11-12T14:30:00.000Z";
    expect(blockedOnSend({ claudeAccount: { ...connected, limitedUntil: until } }, now)).toEqual({
      kind: "limited",
      until,
    });
    expect(
      blockedOnSend({ claudeAccount: { ...connected, limitedUntil: "2026-11-12T09:00:00Z" } }, now),
    ).toBeNull();
    expect(blockedOnSend({ claudeAccount: connected }, now)).toBeNull();
  });

  test("when it resets: a time today, a weekday and a time after", () => {
    const today = new Date(2026, 10, 12, 9, 0);
    expect(resetTime(new Date(2026, 10, 12, 16, 5).toISOString(), today.getTime())).toBe("16:05");
    expect(resetTime(new Date(2026, 10, 16, 9, 0).toISOString(), today.getTime())).toBe(
      "Monday 9:00",
    );
  });
});

describe("a send that didn't make a canvas", () => {
  test("says why in the Mac's words", () => {
    expect(sendFailure(new ApiError(0, "network", "No answer."))).toBe(
      "Ponzu can't be reached. Check your connection and send it again.",
    );
    expect(sendFailure(new ApiError(400, "model_not_offered", "Not offered."))).toBe(
      "Your Claude account doesn't offer that model any more. Check the model and send it again.",
    );
    expect(sendFailure(new Error("boom"))).toBe("That canvas couldn't be made. Try again.");
  });

  test("at a billing limit, only the first, neutral sentence", () => {
    const refusal = new ApiError(
      402,
      "billing_required" as never,
      "Acme's free credits for this month are used up. This canvas waits until a card is added.",
    );
    expect(sendFailure(refusal)).toBe("Acme's free credits for this month are used up.");
    expect(firstSentence("No full stop")).toBe("No full stop");
    expect(firstSentence("It costs $1.50 today. Pay now.")).toBe("It costs $1.50 today.");
  });
});
