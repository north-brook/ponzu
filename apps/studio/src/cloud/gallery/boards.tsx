/* What each composition in compositions.ts draws. */
import type { ReactNode } from "react";
import { repoKey } from "../filter.ts";
import type { Contributor, DesignSummary } from "../model.ts";
import * as f from "./fixtures.ts";
import { CreateHarness, DesignChromeHarness, Harness } from "./harness.tsx";
import { SETUP_BOARDS } from "./setup-boards.tsx";

const ONBOARDING_PROMPT = "I'd like to iterate on the onboarding flow";

function quieter(designs: DesignSummary[]): DesignSummary {
  return designs.find((d) => d.id === "dsn_quieter")!;
}

/** A design open in Northbrook with teammates around: the team boards' window. */
function DesignWindow({
  designs = f.teamDesigns,
  contributors = f.contributors,
  query = null,
  sidebar = "open",
  rail = true,
}: {
  designs?: DesignSummary[];
  contributors?: Contributor[];
  query?: string | null;
  sidebar?: "open" | "closed";
  rail?: boolean;
}) {
  return (
    <Harness
      designs={designs}
      openId="dsn_quieter"
      initialQuery={query}
      sidebar={sidebar}
      rail={rail}
      chrome={(sidebarOpen) => (
        <DesignChromeHarness
          design={quieter(designs)}
          sidebarOpen={sidebarOpen}
          contributors={contributors}
          railOpen={rail}
        />
      )}
    >
      {null}
    </Harness>
  );
}

export const BOARDS: Record<string, () => ReactNode> = {
  "team-sidebar": () => <DesignWindow />,
  "sidebar-team-menu": () => <DesignWindow />,
  "sidebar-filter": () => <DesignWindow />,
  "sidebar-search": () => <DesignWindow query="" />,
  "sidebar-search-results": () => <DesignWindow query="hero" />,
  share: () => <DesignWindow />,
  "thread-in-the-right-rail": () => (
    <DesignWindow designs={f.soloWorking} contributors={f.justYou} />
  ),
  "claude-sets-it-up": () => (
    <Harness
      designs={[f.justCreated, ...f.soloDesigns]}
      openId={f.justCreated.id}
      rail
      chrome={(sidebarOpen) => (
        <DesignChromeHarness
          design={f.justCreated}
          sidebarOpen={sidebarOpen}
          contributors={f.justYou}
          railOpen
          changes={false}
          overrides={{ pages: f.onboardingPages, activePageId: "pg_welcome" }}
        />
      )}
    >
      {null}
    </Harness>
  ),
  create: () => (
    <Harness designs={f.soloDesigns} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} />
    </Harness>
  ),
  "pick-a-project": () => (
    <Harness designs={f.soloDesigns} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} />
    </Harness>
  ),
  "fresh-start": () => (
    <Harness designs={f.teamDesigns} openId={null}>
      <CreateHarness ideas={f.ideas} />
    </Harness>
  ),
  "fresh-start-personal": () => (
    <Harness workspace={f.personal} designs={[]} openId={null} sidebar="none" settledCount={0}>
      <CreateHarness ideas={f.ideas} />
    </Harness>
  ),
  "fresh-start-no-repos": () => (
    <Harness designs={f.teamDesigns} openId={null}>
      <CreateHarness initialProject={{ kind: "scratch" }} repos={[]} />
    </Harness>
  ),
  "fresh-start-loading": () => (
    <Harness designs={null} openId={null}>
      <CreateHarness ideas="loading" repos={null} />
    </Harness>
  ),
  "sidebar-collapsed": () => <DesignWindow sidebar="closed" rail={false} />,
  "settled-open": () => (
    <Harness designs={f.teamDesigns} openId="dsn_quieter" initialSettledOpen>
      {null}
    </Harness>
  ),
  "filtered-empty": () => (
    <Harness
      designs={f.teamDesigns}
      openId={null}
      initialFilter={{ person: f.alex.id, projects: [repoKey(f.lenny)] }}
    >
      {null}
    </Harness>
  ),
  ...SETUP_BOARDS,
};
