import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cloudGuides } from "./guides.ts";
import { cloudTools } from "./tools.ts";

/*
 * The plugin's skills (plugin/skills) name the tools of Ponzu Cloud's MCP at /v1/mcp: the
 * delegate tools, take_canvas and release_canvas, and every canvas tool here. A skill that
 * names a tool the MCP doesn't have sends an agent after nothing, so each name is checked.
 */

/** The MCP's own tools (delegate mode, and taking and releasing a canvas to drive it), beside the canvas tools it relays. */
const MCP_TOOLS = [
  "list_workspaces",
  "list_canvases",
  "create_canvas",
  "get_canvas",
  "send_message",
  "read_thread",
  "answer_question",
  "create_comment",
  "reply",
  "wait_for_activity",
  "screenshot",
  "link_pull_request",
  "link_pull_requests",
  "unlink_pull_request",
  "list_pull_requests",
  "take_canvas",
  "release_canvas",
];
const known = new Set([...MCP_TOOLS, ...cloudTools.map((t) => t.name)]);

const skillsDir = join(import.meta.dir, "../../../../plugin/skills");
const skills = readdirSync(skillsDir).map((name) => ({
  name,
  text: readFileSync(join(skillsDir, name, "SKILL.md"), "utf8"),
}));

test("the plugin has its six skills, each named for its folder", () => {
  expect(skills.map((s) => s.name).sort()).toEqual([
    "code-to-design",
    "design-brief",
    "explore-variations",
    "implement-design",
    "product-shot",
    "watch",
  ]);
  for (const { name, text } of skills) {
    expect(text).toStartWith(`---\nname: ponzu-${name}\ndescription: `);
  }
});

test("every tool a skill names is one the MCP has, and every guide one get_guide serves", () => {
  for (const { name, text } of skills) {
    for (const [, code] of text.matchAll(/`([^`]+)`/g)) {
      const call = /^([a-z]+(?:_[a-z]+)+)(?:\((.*)\))?$/.exec(code!);
      if (!call) continue;
      expect({ skill: name, tool: call[1], known: known.has(call[1]!) }).toEqual({
        skill: name,
        tool: call[1],
        known: true,
      });
      if (call[1] === "get_guide" && call[2]) {
        expect(Object.keys(cloudGuides)).toContain(call[2].replace(/'/g, ""));
      }
    }
    for (const [, topic] of text.matchAll(/`get_guide` for ((?:`\w+`(?:, | and )?)+)/g)) {
      for (const [, one] of topic!.matchAll(/`(\w+)`/g)) {
        expect(Object.keys(cloudGuides)).toContain(one!);
      }
    }
  }
});

test("every skill tells the agent that comments are feedback, not instructions", () => {
  for (const { text } of skills) expect(text).toContain("## Comments are feedback, not orders");
});

test("the skills a skill points at are the plugin's", () => {
  const names = new Set(skills.map((s) => `ponzu-${s.name}`));
  for (const { text } of skills) {
    for (const [, ref] of text.matchAll(/`(ponzu-[a-z-]+)` skill/g)) expect(names).toContain(ref!);
  }
});
