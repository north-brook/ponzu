import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emailRecipient } from "@ponzu/db";
import { call } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { createVault, generateVaultKey } from "../vault/vault.ts";
import { UNSUBSCRIBE_CATEGORIES, type UnsubscribeCategory } from "./kinds.ts";
import { openUnsubscribeToken, unsubscribeToken } from "./unsubscribe.ts";

/*
 * Unsubscribing (docs/cloud.md, "Email"): tokens that name a person and one kind of email, and
 * the route that takes them, where only a POST changes anything.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ mail: true, environment: "production" });
});
afterAll(() => t.close());

let logins = 0;
async function person() {
  const signedIn = await t.signInAs({ login: `rae${++logins}` });
  // Every switch on, so each category has something to turn off.
  await call(t, signedIn.headers, "PATCH", "/v1/me/notifications", {
    emailDigest: true,
    emailTeam: true,
    emailRecap: true,
  });
  return signedIn;
}

const PREF = { digest: "emailDigest", team: "emailTeam", recap: "emailRecap" } as const;
const prefsOf = async (userId: string) => {
  const row = (await emailRecipient(t.db, userId))!;
  return { digest: row.emailDigest, team: row.emailTeam, recap: row.emailRecap };
};
const path = (token: string) => `/v1/email/unsubscribe?t=${encodeURIComponent(token)}`;
const oneClick = (token: string) =>
  t.app.request(path(token), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
const pagePost = (token: string) =>
  t.app.request(path(token), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "via=page",
  });
const unsubscribed = () => t.analytics.events.filter((e) => e.event === "email unsubscribed");

/** #550's two-part token: the id, and the id sealed under the same binding. */
async function oldDigestToken(userId: string) {
  const sealed = await t.deps.vault.seal(userId, { column: "email-unsubscribe", row: userId });
  return `${userId}.${sealed}`;
}

describe("tokens", () => {
  test("round-trip for each category, and #550's two-part token opens as the digest's", async () => {
    const { userId } = await person();
    for (const category of UNSUBSCRIBE_CATEGORIES) {
      const token = await unsubscribeToken(t.deps.vault, userId, category);
      expect(token.startsWith(`${userId}.${category}.pzv1.`)).toBe(true);
      expect(await openUnsubscribeToken(t.deps.vault, token)).toEqual({ userId, category });
    }
    expect(await openUnsubscribeToken(t.deps.vault, await oldDigestToken(userId))).toEqual({
      userId,
      category: "digest",
    });
  });

  test("a forged, cross-person or swapped-category token is refused", async () => {
    const maya = await person();
    const sam = await person();
    const team = await unsubscribeToken(t.deps.vault, sam.userId, "team");
    const sealed = team.slice(`${sam.userId}.team.`.length);
    const forged = [
      // Sam's team token with the category swapped: the category is inside the seal.
      `${sam.userId}.recap.${sealed}`,
      `${sam.userId}.digest.${sealed}`,
      // Sam's seal under Maya's id.
      `${maya.userId}.team.${sealed}`,
      // #550's token given a category, and a category's seal passed off as #550's.
      `${sam.userId}.team.${(await oldDigestToken(sam.userId)).slice(sam.userId.length + 1)}`,
      `${sam.userId}.${sealed}`,
      // Another key's token.
      await unsubscribeToken(createVault({ key: generateVaultKey() }), sam.userId, "team"),
      // A category that is not one, and not a token at all.
      `${sam.userId}.billing.${sealed}`,
      `${team.slice(0, -2)}xx`,
      sam.userId,
      "",
    ];
    for (const token of forged) {
      expect(await openUnsubscribeToken(t.deps.vault, token)).toBeNull();
      const page = await t.app.request(path(token));
      expect(page.status).toBe(400);
      expect(await page.text()).toContain("This link doesn");
      expect((await oneClick(token)).status).toBe(400);
      expect((await pagePost(token)).status).toBe(400);
    }
    expect((await t.app.request("/v1/email/unsubscribe")).status).toBe(400);
    for (const who of [maya, sam]) {
      expect(await prefsOf(who.userId)).toEqual({ digest: true, team: true, recap: true });
    }
  });
});

describe("the route", () => {
  test("GET only asks: nothing changes and nothing is counted, however often it is fetched", async () => {
    const { userId } = await person();
    const before = unsubscribed().length;
    for (const category of UNSUBSCRIBE_CATEGORIES) {
      const token = await unsubscribeToken(t.deps.vault, userId, category);
      for (let n = 0; n < 3; n++) {
        const page = await t.app.request(path(token));
        expect(page.status).toBe(200);
        expect(page.headers.get("cache-control")).toBe("no-store");
        expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
        const html = await page.text();
        expect(html).toContain('<button class="cta" type="submit">Stop these emails</button>');
      }
    }
    // A HEAD, as some scanners send, changes nothing either.
    await t.app.request(path(await unsubscribeToken(t.deps.vault, userId, "recap")), {
      method: "HEAD",
    });
    expect(await prefsOf(userId)).toEqual({ digest: true, team: true, recap: true });
    expect(unsubscribed().length).toBe(before);
  });

  test("each page asks its own question", async () => {
    const { userId } = await person();
    const questions: Record<UnsubscribeCategory, string> = {
      digest: "Stop Ponzu's daily email?",
      team: "Stop emails when people join?",
      recap: "Stop Ponzu's Friday recap?",
    };
    for (const category of UNSUBSCRIBE_CATEGORIES) {
      const token = await unsubscribeToken(t.deps.vault, userId, category);
      expect(await (await t.app.request(path(token))).text()).toContain(
        `<h1>${questions[category]}</h1>`,
      );
    }
  });

  test("a one-click POST turns off its own kind alone, with 204, and is counted", async () => {
    for (const category of UNSUBSCRIBE_CATEGORIES) {
      const { userId } = await person();
      const answer = await oneClick(await unsubscribeToken(t.deps.vault, userId, category));
      expect(answer.status).toBe(204);
      expect(await prefsOf(userId)).toEqual({
        digest: category !== "digest",
        team: category !== "team",
        recap: category !== "recap",
      });
      expect(unsubscribed().at(-1)).toMatchObject({
        distinctId: userId,
        properties: { kind: category, via: "one_click" },
      });
    }
  });

  test("the page's button turns it off and says so, in each kind's words", async () => {
    const done: Record<UnsubscribeCategory, string> = {
      digest: "You won't get Ponzu's daily email any more.",
      team: "You won't get an email when people join a workspace any more.",
      recap: "You won't get Ponzu's Friday recap any more.",
    };
    for (const category of UNSUBSCRIBE_CATEGORIES) {
      const { userId, headers } = await person();
      const answer = await pagePost(await unsubscribeToken(t.deps.vault, userId, category));
      expect(answer.status).toBe(200);
      const html = await answer.text();
      expect(html).toContain(`<h1>${done[category]}</h1>`);
      expect(html).toContain("Turn it back on in Ponzu, in Settings › Notifications.");
      expect(html).not.toContain("<form");
      const settings = await call(t, headers, "GET", "/v1/me/notifications");
      expect(settings.body.prefs[PREF[category]]).toBe(false);
      expect(unsubscribed().at(-1)).toMatchObject({ properties: { kind: category, via: "page" } });
    }
  });

  test("#550's token still stops the digest, and only the digest", async () => {
    const { userId } = await person();
    expect((await oneClick(await oldDigestToken(userId))).status).toBe(204);
    expect(await prefsOf(userId)).toEqual({ digest: false, team: true, recap: true });
  });
});
