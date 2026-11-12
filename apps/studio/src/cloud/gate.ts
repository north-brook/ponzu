import { firstName, type SteerGate } from "./model.ts";
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
  if (gate.kind === "claude_owner_left") {
    return "Its owner left the workspace. A canvas runs on its owner's Claude alone, so this one can't run again. You can still look through it.";
  }
  const you = gate.owner.id === meId;
  const whose = you ? "Your" : `${firstName(gate.owner)}'s`;
  switch (gate.kind) {
    case "claude_limit":
      return `${whose} plan is at its limit until ${clock(gate.until)}. This canvas waits.`;
    case "claude_expired":
      return `${whose} Claude sign-in has run out. This canvas waits.`;
    case "claude_disconnected":
      return `${whose} Claude isn't connected. This canvas waits.`;
  }
}
