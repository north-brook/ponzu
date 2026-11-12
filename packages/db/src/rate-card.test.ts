import { afterAll, beforeAll, expect, test } from "bun:test";
import { desc } from "drizzle-orm";
import { PUBLISHED_RATE_CARD } from "./rate-card.ts";
import { rateCards } from "./schema/index.ts";
import { createTestDb } from "./testing.ts";

/*
 * The site prints the prices from PUBLISHED_RATE_CARD; the API bills from the rows. Here, with
 * every migration applied, the newest row has to say exactly what the constant says. A migration
 * that adds a rate card (a price change is a new row, never an edit) fails this until the
 * constant follows it, and so does a new pricing column the constant doesn't carry.
 */

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** Columns that aren't a price people read: when it took effect, model rates, bookkeeping. */
const NOT_PUBLISHED = ["effectiveFrom", "modelRates", "createdAt"];

test("the published rate card is the newest rate_cards row", async () => {
  const [newest] = await db.select().from(rateCards).orderBy(desc(rateCards.version)).limit(1);
  expect(newest).toBeDefined();
  const published = Object.fromEntries(
    Object.entries(newest!).filter(([key]) => !NOT_PUBLISHED.includes(key)),
  );
  expect(published).toEqual({ ...PUBLISHED_RATE_CARD });
});

test("the newest rate card prices no model turns, as the site says", async () => {
  // The site says Claude runs on the person's own plan and Ponzu adds nothing for tokens. A card
  // that prices model turns would make that untrue, so it has to change the site's words too.
  const [newest] = await db.select().from(rateCards).orderBy(desc(rateCards.version)).limit(1);
  expect(newest!.modelRates).toEqual({});
});
