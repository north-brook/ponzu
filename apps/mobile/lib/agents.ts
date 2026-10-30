/** An agent's product, for its mark, from a thread author's name. */
export function clientOf(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex") || n.includes("openai") || n.includes("gpt")) return "openai";
  return undefined;
}

/** "Claude" from "Claude Code" or "claude-code". */
export function shortAgent(name: string): string {
  const c = clientOf(name);
  if (c === "claude") return "Claude";
  if (c === "openai") return "Codex";
  return name.split(/[\s-]/)[0] ?? name;
}
