import { longDate, money } from "./billing.ts";
import { firstName, type Person, type SteerGate } from "./model.ts";
import { clock } from "./time.ts";

/**
 * What the rail says when nobody can steer the canvas, in the owner's terms: "Bryce's plan is
 * at its limit until 4:00 PM. This canvas waits." A canvas runs on its owner's Claude alone, so
 * a limit or a lost connection pauses it for everyone and nobody else's plan stands in.
 */
export function gateMessage(gate: SteerGate, meId: string): string {
  if (gate.kind === "read_only") {
    return gate.repo
      ? `You can view this canvas. Ask for write access to ${gate.repo.owner}/${gate.repo.name} to steer it.`
      : "You can view this canvas.";
  }
  if (gate.kind === "claude_owner_left") return ownerLeftLine(gate);
  const whose = whoseClaude(gate.owner, meId);
  switch (gate.kind) {
    case "claude_limit":
      return limitLine(whose, gate.until);
    case "claude_expired":
      return `${whose} Claude sign-in has run out. This canvas waits.`;
    case "claude_disconnected":
      return `${whose} Claude isn't connected. This canvas waits.`;
  }
}

/**
 * A canvas whose owner left the workspace (or deleted their account), word for word from
 * the sweep plan, §8: to someone who can take it over, what pressing "Take over" does; to anyone
 * else, who can.
 */
function ownerLeftLine(gate: Extract<SteerGate, { kind: "claude_owner_left" }>): string {
  if (gate.canTakeOver) {
    return "Its owner left the workspace. Take it over to run it on your Claude.";
  }
  const nobody = "Its owner left the workspace, so nobody's Claude runs it.";
  return gate.repo
    ? `${nobody} Someone who can change ${gate.repo.owner}/${gate.repo.name} can take it over.`
    : nobody;
}

/** "Your", or "Maya's": whose Claude the canvas runs on, said to the viewer. */
function whoseClaude(owner: Person, meId: string): string {
  return owner.id === meId ? "Your" : `${firstName(owner)}'s`;
}

function limitLine(whose: string, until: string): string {
  return `${whose} plan is at its limit until ${clock(until)}. This canvas waits.`;
}

/*
 * The blockers the API's wake gates give (apps/api/src/sandboxes/gates.ts), in the words people
 * read when one appears on a canvas's head. Written here once, word for word from the plans
 * (billing §11, sweep §6, production §1.5), for the features that show them: the thread's
 * waiting line on the Mac, and on the iPhone its first sentence and what the canvas does.
 * Nothing shows them until a gate gives its blocker.
 */

/** A workspace as the billing lines name it; a personal one speaks to its person. */
interface BlockerWorkspace {
  name: string;
  personal: boolean;
}

/** A gate's blocker, with what its words need to know. */
export type GateBlocker =
  | { blocker: "paused" }
  | {
      blocker: "credits_used_up" | "payment_failed";
      workspace: BlockerWorkspace;
      /** Whether the reader may manage billing: only they get the button. */
      canManage: boolean;
    }
  | {
      blocker: "cap_reached";
      workspace: BlockerWorkspace;
      canManage: boolean;
      /** The workspace's monthly spend cap, in dollars. */
      capUsd: number;
      /** When the billing period resets (ISO 8601). */
      periodEnd: string;
    }
  | {
      blocker: "claude_limited";
      /** The canvas's owner, whose Claude it runs on, and who is reading. */
      owner: Person;
      meId: string;
      /** The head's `agentBlockedUntil`: when the plan's limit resets. */
      until: string;
    };

/** What the thread says about a gate's blocker. */
export interface BlockerWords {
  /** The Mac's waiting line. */
  line: string;
  /** The iPhone's line. */
  phone: string;
  /** The Mac's button beside the line, for someone who can act on it; null when there is none. */
  action: "Add a card" | "Raise cap" | "Pay invoice" | null;
  /** A line under the gate when what the person sends is kept until then; else null. */
  queued: string | null;
}

/** The Mac's line, the iPhone's, and the button, for a gate's blocker. */
export function blockerWords(gate: GateBlocker): BlockerWords {
  switch (gate.blocker) {
    case "paused": {
      const line =
        "The agent is paused while Ponzu updates. Your message is kept and goes through when it's back.";
      return { line, phone: line, action: null, queued: null };
    }
    case "credits_used_up": {
      const { workspace } = gate;
      const first = workspace.personal
        ? "Your free credits for this month are used up."
        : `${workspace.name}'s free credits for this month are used up.`;
      const then = workspace.personal
        ? "This canvas waits until you add a card."
        : "This canvas waits until a card is added.";
      return {
        line: `${first} ${then}`,
        phone: `${first} This canvas waits.`,
        action: gate.canManage ? "Add a card" : null,
        queued: null,
      };
    }
    case "cap_reached": {
      const first = `${gate.workspace.name} has reached this month's ${money(gate.capUsd, true)} cap.`;
      const resets = longDate(gate.periodEnd);
      return {
        line: `${first} This canvas waits until the cap is raised or it resets on ${resets}.`,
        phone: `${first} This canvas waits until ${resets}.`,
        action: gate.canManage ? "Raise cap" : null,
        queued: null,
      };
    }
    case "payment_failed": {
      const first = `${gate.workspace.name}'s last payment didn't go through.`;
      return {
        line: `${first} This canvas waits until it's paid.`,
        phone: `${first} This canvas waits.`,
        action: gate.canManage ? "Pay invoice" : null,
        queued: null,
      };
    }
    case "claude_limited": {
      const line = limitLine(whoseClaude(gate.owner, gate.meId), gate.until);
      return { line, phone: line, action: null, queued: "Your message goes in when it resets." };
    }
  }
}
