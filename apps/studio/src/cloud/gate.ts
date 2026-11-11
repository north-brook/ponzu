import { firstName, type SteerGate } from "./model.ts";
import { clock } from "./time.ts";

/**
 * What the rail says when nobody can steer the design, in the owner's terms: "Bryce's plan is
 * at its limit until 4:00 PM. This design waits." A design runs on its owner's Claude alone, so
 * a limit or a lost connection pauses it for everyone and nobody else's plan stands in.
 */
export function gateMessage(gate: SteerGate, meId: string): string {
  if (gate.kind === "read_only") {
    return gate.repo
      ? `You can view this design. Ask for write access to ${gate.repo.owner}/${gate.repo.name} to steer it.`
      : "You can view this design.";
  }
  const you = gate.owner.id === meId;
  const whose = you ? "Your" : `${firstName(gate.owner)}'s`;
  return gate.kind === "claude_limit"
    ? `${whose} plan is at its limit until ${clock(gate.until)}. This design waits.`
    : `${whose} Claude isn't connected. This design waits.`;
}
