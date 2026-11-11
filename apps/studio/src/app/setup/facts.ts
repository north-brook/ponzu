import type { Api } from "@ponzu/client";
import type { SetupFacts } from "../../cloud/setup/setup.ts";

/*
 * What the guided setup's gates read (cloud/setup/setup.ts), from the API's answers. Pure, so
 * the gates are tested from what the API says: a new person, a returning one, a second device.
 */

type Me = Awaited<ReturnType<Api["me"]>>;

/**
 * The gates' facts from `GET /v1/me`. A Claude sign-in in progress is the step's own (the card
 * holds it), so the gates never need it. Nothing yet tells the Mac whether an iPhone is signed in (there are no devices
 * in the API yet), so the iPhone step shows once to everyone who sets up on a Mac.
 *
 * The API answers no Claude at all once one is disconnected, as for someone who never had one.
 * Someone who has seen the iPhone step was through setup with a Claude connected, so for them
 * no Claude is a Claude signed out: a send asks them to connect it again, and setup does not.
 */
export function setupFacts(me: Me): SetupFacts {
  const iphoneStepSeen = me.onboarding.iphoneStepSeenAt !== null;
  return {
    signedIn: true,
    workspaces: me.workspaces.map(({ installed, suspended }) => ({ installed, suspended })),
    whereConfirmed: me.onboarding.whereConfirmedAt !== null,
    claude: me.claudeAccount
      ? { status: me.claudeAccount.status }
      : iphoneStepSeen
        ? { status: "revoked" }
        : null,
    claudeSignIn: null,
    iphoneStepSeen,
    hasIphone: false,
  };
}
