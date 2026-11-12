import { resolveClosedQuestions } from "@ponzu/db";
import { scheduleBadges } from "../../notifications/badge.ts";
import type { CronStep } from "../steps.ts";

/**
 * Resolve the needs-you notifications whose question closed without the route that closed it
 * saying so (a sandbox lost, a request that died), and push the badges that went down.
 */
export const resolveQuestionsStep: CronStep = {
  name: "resolve_questions",
  run: async (deps, now) => {
    const lowered = await resolveClosedQuestions(deps.db, { now });
    await scheduleBadges(deps, lowered);
    return { lowered: lowered.length };
  },
};
