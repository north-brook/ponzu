import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NOW } from "../gallery/fixtures.ts";
import { NowContext } from "../time.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { ThreadToggle, type ToggleDriver } from "./thread-toggle.tsx";

/*
 * The thread rail's toggle while the person's own agent drives the canvas (docs/cloud.md, "Your
 * own agent"): the agent's mark in place of the rail's icon, named for assistive tech, with no
 * rail to open or close.
 */

const ignore = () => {};

const html = (driver: ToggleDriver | null, open = false) =>
  renderToStaticMarkup(
    <NowContext.Provider value={() => NOW}>
      <TipProvider>
        <ThreadToggle open={open} signal="idle" onToggle={ignore} driver={driver} />
      </TipProvider>
    </NowContext.Provider>,
  );

const claude: ToggleDriver = {
  client: "claude",
  name: "Claude Code",
  host: "T3 Code",
  since: new Date(NOW - 40 * 60_000).toISOString(),
  onTakeBack: ignore,
};

test("without a driver it is the rail's toggle", () => {
  const shown = html(null, true);
  expect(shown).toContain('aria-label="Thread"');
  expect(shown).toContain('aria-controls="thread"');
  expect(shown).toContain('aria-expanded="true"');
});

test("while an agent drives, it is that agent's mark and says who drives", () => {
  const shown = html(claude);
  expect(shown).toContain('aria-label="Claude Code is driving this canvas"');
  expect(shown).toContain('aria-label="Claude"');
  expect(shown).toContain('data-driver="claude"');
  // There is no rail to open: it opens its popover instead.
  expect(shown).not.toContain('aria-controls="thread"');
  expect(shown).toContain('aria-haspopup="dialog"');
});

test("each agent gets its own mark: Codex is OpenAI's, then Cursor and T3 Code", () => {
  expect(html({ ...claude, client: "openai", name: "Codex" })).toContain('aria-label="OpenAI"');
  expect(html({ ...claude, client: "cursor", name: "Cursor" })).toContain('aria-label="Cursor"');
  expect(html({ ...claude, client: "t3", name: "T3 Code" })).toContain('aria-label="T3 Code"');
  expect(html({ ...claude, client: "zed", name: "Zed" })).toContain('aria-label="Agent"');
});
