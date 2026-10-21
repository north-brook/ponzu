import { converseTools } from "./converse.ts";
import type { ToolDef } from "./define.ts";
import { listenTools } from "./listen.ts";
import { organizeTools } from "./organize.ts";
import { orientTools } from "./orient.ts";
import { seeTools } from "./see.ts";
import { writeTools } from "./write.ts";

export * from "./context.ts";
export { threadLine } from "./converse.ts";
export * from "./define.ts";
export { GUIDES, type GuideTopic, SERVER_INSTRUCTIONS } from "./guides.ts";
export { describeEvent } from "./listen.ts";
export { fileList, resolveFile } from "./util.ts";

/** Every Ponzu tool, in the order agents should discover them. */
export const tools: ToolDef<any>[] = [
  ...orientTools,
  ...writeTools,
  ...seeTools,
  ...organizeTools,
  ...converseTools,
  ...listenTools,
];

export function getTool(name: string): ToolDef<any> | undefined {
  return tools.find((t) => t.name === name);
}
