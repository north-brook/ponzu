/* What each composition in compositions.ts draws. */
import type { Doc } from "@ponzu/core";
import { type ReactNode, useState } from "react";
import { type CanvasFilter, repoKey } from "../filter.ts";
import type { CanvasMember, CanvasSummary, Contributor } from "../model.ts";
import { BoardsPane, SHOW_BOARDS } from "./boards-pane.tsx";
import { heroBoards, teamHeroBoards } from "./canvas-fixtures.ts";
import { CanvasHarness } from "./canvas-harness.tsx";
import * as f from "./fixtures.ts";
import { CanvasChromeHarness, CreateHarness, Harness } from "./harness.tsx";
import { LivePreviews } from "./live-previews.tsx";
import { OpeningWindow } from "./opening.tsx";
import { SendHarness } from "./send-harness.tsx";
import { SETUP_BOARDS } from "./setup-boards.tsx";
import { THREAD_BOARDS } from "./thread-boards.tsx";
import * as t from "./thread-fixtures.ts";

const ONBOARDING_PROMPT = "I'd like to iterate on the onboarding flow";
/** A name past the chrome's 240: cut with an ellipsis there. */
const LONG_NAME = "Quieter hero with the pricing table, the testimonials and a calmer footer";

function quieter(canvases: CanvasSummary[]): CanvasSummary {
  return canvases.find((d) => d.id === "cnv_quieter")!;
}

/** A canvas open in Thistlewick with teammates around: the team boards' window. */
function CanvasWindow({
  canvases = f.teamCanvases,
  contributors = f.contributors,
  query = null,
  sidebar = "open",
  rail: initialRail = true,
  members = f.members,
  boards,
}: {
  canvases?: CanvasSummary[];
  contributors?: Contributor[];
  query?: string | null;
  sidebar?: "open" | "closed";
  rail?: boolean;
  /** Who Share lists. */
  members?: CanvasMember[];
  /** The canvas's boards, drawn with `&boards` (boards-pane.tsx). */
  boards?: Doc;
}) {
  const [rail, setRail] = useState(initialRail);
  return (
    <Harness
      canvases={canvases}
      openId="cnv_quieter"
      initialQuery={query}
      sidebar={sidebar}
      rail={rail}
      chrome={(sidebarOpen) => (
        <CanvasChromeHarness
          canvas={quieter(canvases)}
          sidebarOpen={sidebarOpen}
          contributors={contributors}
          railOpen={rail}
          onToggleRail={() => setRail((o) => !o)}
          members={members}
        />
      )}
    >
      {boards && SHOW_BOARDS ? <BoardsPane doc={boards} /> : null}
    </Harness>
  );
}

/**
 * More canvases and pages than the numbers reach, for the ⌘ and ⌥ shortcuts and their hints:
 * twelve canvases (⌘9 is the last, the ninth to eleventh get none) and eleven pages, two of them
 * without an icon.
 */
const manyCanvases: CanvasSummary[] = [
  ...f.soloCanvases,
  ...f.soloCanvases.slice(1, 6).map((d, i) => ({
    ...d,
    id: `${d.id}_more`,
    name: `${d.name} (${i + 2})`,
    lastActivityAt: new Date(Date.parse(d.lastActivityAt) - 86_400_000).toISOString(),
  })),
];
const manyPages = [
  ...f.homePages,
  { id: "pg_checkout", name: "Checkout", icon: null, working: false },
  { id: "pg_cart", name: "Cart", icon: "card", working: false },
  { id: "pg_account", name: "Account", icon: "list", working: false },
  { id: "pg_emails", name: "Emails", icon: null, working: false },
  { id: "pg_search", name: "Search", icon: "list", working: false },
  { id: "pg_empty", name: "Empty states", icon: "card", working: false },
  { id: "pg_errors", name: "Errors", icon: "list", working: false },
  { id: "pg_mobile", name: "Mobile", icon: "phone", working: false },
];

function ShortcutsWindow({
  sidebar = "open",
  filter,
}: {
  sidebar?: "open" | "closed";
  filter?: CanvasFilter;
}) {
  const quieterRow = quieter(manyCanvases);
  return (
    <Harness
      canvases={manyCanvases}
      openId="cnv_quieter"
      sidebar={sidebar}
      {...(filter ? { initialFilter: filter } : {})}
      chrome={(sidebarOpen) => (
        <CanvasChromeHarness
          canvas={quieterRow}
          sidebarOpen={sidebarOpen}
          contributors={null}
          railOpen={false}
          overrides={{ pages: manyPages }}
        />
      )}
    >
      {null}
    </Harness>
  );
}

export const BOARDS: Record<string, () => ReactNode> = {
  shortcuts: () => <ShortcutsWindow />,
  "shortcuts-collapsed": () => <ShortcutsWindow sidebar="closed" />,
  "shortcuts-filtered": () => (
    <ShortcutsWindow filter={{ person: null, projects: [repoKey(f.fernwood)] }} />
  ),
  "team-sidebar": () => <CanvasWindow boards={teamHeroBoards} />,
  "sidebar-team-menu": () => <CanvasWindow />,
  "sidebar-filter": () => <CanvasWindow />,
  "sidebar-search": () => <CanvasWindow query="" />,
  "sidebar-search-results": () => <CanvasWindow query="hero" />,
  share: () => <CanvasWindow />,
  "share-not-joined": () => <CanvasWindow members={f.membersMixed} />,
  "sidebar-previews-updating": () => <LivePreviews />,
  "canvas-opening": () => <OpeningWindow known="row" />,
  "canvas-opening-launch": () => <OpeningWindow known="nothing" sidebar="closed" />,
  "thread-in-the-right-rail": () => (
    <CanvasHarness
      canvases={f.soloWorking}
      canvas={quieter(f.soloWorking)}
      contributors={f.justYou}
      thread={t.heroThread}
      agent={t.heroAgent}
      // As the boards go on: board 2's questions follow your next message.
      then={t.boardAsks}
      boards={heroBoards}
    />
  ),
  "claude-sets-it-up": () => (
    <CanvasHarness
      canvases={[f.justCreated, ...f.soloCanvases]}
      canvas={f.justCreated}
      contributors={f.justYou}
      pages={f.onboardingPages}
      thread={t.setUpThread}
      agent={t.setUpAgent}
      changes={false}
    />
  ),
  create: () => (
    <Harness canvases={f.soloCanvases} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} />
    </Harness>
  ),
  "create-model-menu": () => (
    <Harness canvases={f.soloCanvases} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} />
    </Harness>
  ),
  "pick-a-project": () => (
    <Harness canvases={f.soloCanvases} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} />
    </Harness>
  ),
  "pick-a-project-scratch": () => (
    <Harness canvases={f.soloCanvases} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} initialProject={{ kind: "scratch" }} />
    </Harness>
  ),
  "pick-a-project-one-repo": () => (
    <Harness canvases={f.soloCanvases} openId={null}>
      <CreateHarness
        initialPrompt={ONBOARDING_PROMPT}
        initialProject={{ kind: "repo", repo: f.oneRepo[0]! }}
        repos={f.oneRepo}
      />
    </Harness>
  ),
  "pick-a-project-many-repos": () => (
    <Harness canvases={f.soloCanvases} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} repos={f.manyRepos} />
    </Harness>
  ),
  "pick-a-project-workspaces": () => (
    <Harness canvases={f.soloCanvases} openId={null} workspaces={[f.thistlewick, f.brambleSchool]}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} shelves={f.shelves} />
    </Harness>
  ),
  "pick-a-project-workspaces-loading": () => (
    <Harness canvases={f.soloCanvases} openId={null} workspaces={[f.thistlewick, f.brambleSchool]}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} shelves={f.shelves} later />
    </Harness>
  ),
  "pick-a-project-three-workspaces": () => (
    <Harness
      canvases={f.soloCanvases}
      openId={null}
      workspaces={[f.thistlewick, f.brambleSchool, f.personal]}
    >
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} shelves={f.threeShelves} />
    </Harness>
  ),
  "fresh-start-long-name": () => (
    <Harness canvases={f.soloCanvases} openId={null}>
      <CreateHarness
        initialProject={{ kind: "repo", repo: f.longNamedRepo }}
        repos={[f.longNamedRepo, ...f.repos]}
      />
    </Harness>
  ),
  "fresh-start": () => (
    <Harness canvases={f.teamCanvases} openId={null}>
      <CreateHarness ideas={f.ideas} />
    </Harness>
  ),
  "fresh-start-short": () => (
    <Harness canvases={f.teamCanvases} openId={null}>
      <CreateHarness ideas={f.ideas} />
    </Harness>
  ),
  "fresh-start-tall": () => (
    <Harness canvases={f.teamCanvases} openId={null}>
      <CreateHarness ideas={f.ideas} />
    </Harness>
  ),
  "create-send": () => <SendHarness initialPrompt={ONBOARDING_PROMPT} />,
  "fresh-start-personal": () => (
    <Harness workspace={f.personal} canvases={[]} openId={null} sidebar="none" settledCount={0}>
      <CreateHarness ideas={f.ideas} />
    </Harness>
  ),
  "fresh-start-no-repos": () => (
    <Harness canvases={f.teamCanvases} openId={null}>
      <CreateHarness initialProject={{ kind: "scratch" }} repos={[]} />
    </Harness>
  ),
  "fresh-start-loading": () => (
    <Harness canvases={null} openId={null}>
      <CreateHarness ideas="loading" repos={null} initialProject={null} />
    </Harness>
  ),
  "sidebar-collapsed": () => <CanvasWindow sidebar="closed" rail={false} />,
  "sidebar-collapsed-long-name": () => (
    <CanvasWindow
      canvases={f.teamCanvases.map((d) => (d.id === "cnv_quieter" ? { ...d, name: LONG_NAME } : d))}
      sidebar="closed"
    />
  ),
  "min-window": () => <CanvasWindow />,
  "min-window-collapsed": () => <CanvasWindow sidebar="closed" />,
  "settled-open": () => (
    <Harness canvases={f.teamCanvases} openId="cnv_quieter" initialSettledOpen>
      {null}
    </Harness>
  ),
  "filtered-empty": () => (
    <Harness
      canvases={f.teamCanvases}
      openId={null}
      initialFilter={{ person: f.alex.id, projects: [repoKey(f.almanac)] }}
    >
      {null}
    </Harness>
  ),
  ...THREAD_BOARDS,
  ...SETUP_BOARDS,
};
