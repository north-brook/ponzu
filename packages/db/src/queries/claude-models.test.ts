import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedUser } from "../fixtures.ts";
import type { ClaudeModelReport } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  claudeAccountIdFor,
  connectClaudeAccount,
  disconnectClaudeAccount,
  getClaudeAccountById,
  recordClaudeModels,
} from "./claude.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const OPUS: ClaudeModelReport = {
  value: "opus",
  resolvedModel: "claude-opus-5-5",
  displayName: "Opus",
  description: "Opus 5.5 · Best for everyday, complex tasks",
  efforts: ["low", "medium", "high", "xhigh", "max"],
};

async function connected(login: string, at: Date) {
  const user = await seedUser(db, login);
  const id = await claudeAccountIdFor(db, user.id);
  const account = await connectClaudeAccount(db, {
    id,
    userId: user.id,
    kind: "api_key",
    encryptedCredential: "sealed",
    keyHint: "4f2a",
    expiresAt: null,
    now: at,
  });
  if (!account) throw new Error("not connected");
  return { user, account };
}

describe("what Claude Code offers an account", () => {
  test("is kept with when it was reported and which Claude Code said so", async () => {
    const at = new Date("2026-11-01T10:00:00.000Z");
    const { account } = await connected("reported", at);
    expect(account).toMatchObject({ models: null, modelsReportedAt: null, modelsClaudeCode: null });

    const now = new Date("2026-11-02T08:30:00.000Z");
    const kept = await recordClaudeModels(db, {
      claudeAccountId: account.id,
      connectedAt: at,
      claudeCode: "2.1.322",
      models: [OPUS],
      now,
    });

    expect(kept).toBe(true);
    expect(await getClaudeAccountById(db, account.id)).toMatchObject({
      models: [OPUS],
      modelsReportedAt: now,
      modelsClaudeCode: "2.1.322",
    });
  });

  test("is not kept from a runner on a credential since replaced, and a new one clears it", async () => {
    const first = new Date("2026-11-01T10:00:00.000Z");
    const { user, account } = await connected("replaced", first);
    await recordClaudeModels(db, {
      claudeAccountId: account.id,
      connectedAt: first,
      claudeCode: "2.1.322",
      models: [OPUS],
      now: first,
    });
    const second = new Date("2026-11-03T10:00:00.000Z");
    const again = await connectClaudeAccount(db, {
      id: account.id,
      userId: user.id,
      kind: "subscription",
      encryptedCredential: "sealed again",
      keyHint: null,
      expiresAt: null,
      now: second,
    });
    expect(again).toMatchObject({ id: account.id, models: null, modelsReportedAt: null });

    const late = await recordClaudeModels(db, {
      claudeAccountId: account.id,
      connectedAt: first,
      claudeCode: "2.1.322",
      models: [OPUS],
      now: second,
    });

    expect(late).toBe(false);
    expect((await getClaudeAccountById(db, account.id))?.models).toBeNull();
  });

  test("is not kept for a disconnected account", async () => {
    const at = new Date("2026-11-01T10:00:00.000Z");
    const { user, account } = await connected("gone", at);
    await disconnectClaudeAccount(db, user.id);

    const kept = await recordClaudeModels(db, {
      claudeAccountId: account.id,
      connectedAt: at,
      claudeCode: "2.1.322",
      models: [OPUS],
      now: at,
    });

    expect(kept).toBe(false);
  });

  test("getClaudeAccountById never hands back the credential", async () => {
    const { account } = await connected("sealed", new Date("2026-11-01T10:00:00.000Z"));
    const read = await getClaudeAccountById(db, account.id);
    expect(read?.id).toBe(account.id);
    expect(JSON.stringify(read)).not.toContain("sealed");
    expect(await getClaudeAccountById(db, "cla_nobody")).toBeNull();
  });
});
