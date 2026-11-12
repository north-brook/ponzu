// What Claude Code offers an account, kept and read back on a real Postgres through every driver
// that reaches one: the report is json, and the guard compares a timestamptz the driver sent.
// Runs only when PONZU_TEST_DATABASE_URL is set (see ../live.ts).
import { afterAll, expect, test } from "bun:test";
import { seedUser } from "../fixtures.ts";
import { describeLive } from "../live.ts";
import type { ClaudeModelReport } from "../schema/index.ts";
import {
  claudeAccountIdFor,
  connectClaudeAccount,
  getClaudeAccountById,
  recordClaudeModels,
} from "./claude.ts";

const MODELS: ClaudeModelReport[] = [
  {
    value: "fable",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable",
    description: "Fable 5.2 · Most capable for your hardest and longest-running tasks",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-new-1",
    resolvedModel: null,
    displayName: "New",
    description: "",
    efforts: null,
  },
];

describeLive("Claude models on a real Postgres", ({ db, close }) => {
  afterAll(close);

  test("a report is kept for the credential it was made on, and not for the next", async () => {
    const user = await seedUser(db, "models-live");
    const id = await claudeAccountIdFor(db, user.id);
    const connect = (at: Date) =>
      connectClaudeAccount(db, {
        id,
        userId: user.id,
        kind: "api_key",
        encryptedCredential: "sealed",
        keyHint: "4f2a",
        expiresAt: null,
        now: at,
      });
    const first = new Date("2026-11-01T10:00:00.123Z");
    await connect(first);
    const now = new Date("2026-11-02T08:30:00.456Z");

    expect(
      await recordClaudeModels(db, {
        claudeAccountId: id,
        connectedAt: first,
        claudeCode: "2.1.322",
        models: MODELS,
        now,
      }),
    ).toBe(true);
    expect(await getClaudeAccountById(db, id)).toMatchObject({
      models: MODELS,
      modelsReportedAt: now,
      modelsClaudeCode: "2.1.322",
    });

    await connect(new Date("2026-11-03T10:00:00.789Z"));
    expect(
      await recordClaudeModels(db, {
        claudeAccountId: id,
        connectedAt: first,
        claudeCode: "2.1.322",
        models: MODELS,
        now,
      }),
    ).toBe(false);
    expect((await getClaudeAccountById(db, id))?.models).toBeNull();
  });
});
