import { checkPushReceipts } from "../../notifications/receipts.ts";
import type { CronStep } from "../steps.ts";

/** What became of the pushes Expo took, and the sends that were never answered. */
export const receiptsStep: CronStep = {
  name: "receipts",
  run: (deps, now) => checkPushReceipts(deps, now),
};
