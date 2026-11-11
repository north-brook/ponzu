/* What each composition in compositions.ts draws. */
import type { ReactNode } from "react";
import { type DesignFilter, repoKey } from "../filter.ts";
import type { Contributor, DesignMember, DesignSummary } from "../model.ts";
import { DesignHarness } from "./design-harness.tsx";
import * as f from "./fixtures.ts";
import { CreateHarness, DesignChromeHarness, Harness } from "./harness.tsx";
import { LivePreviews } from "./live-previews.tsx";
import { SETUP_BOARDS } from "./setup-boards.tsx";
import { THREAD_BOARDS } from "./thread-boards.tsx";
import * as t from "./thread-fixtures.ts";

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
  members = f.members,
}: {
  designs?: DesignSummary[];
  contributors?: Contributor[];
  query?: string | null;
  sidebar?: "open" | "closed";
  rail?: boolean;
  /** Who Share lists. */
  members?: DesignMember[];
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
          members={members}
        />
      )}
    >
      {null}
    </Harness>
  );
}

/**
 * More designs and pages than the numbers reach, for the ⌘ and ⌥ shortcuts and their hints:
 * twelve designs (⌘9 is the last, the ninth to eleventh get none) and eleven pages, two of them
 * without an icon.
 */
const manyDesigns: DesignSummary[] = [
  ...f.soloDesigns,
  ...f.soloDesigns.slice(1, 6).map((d, i) => ({
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
  filter?: DesignFilter;
}) {
  const quieterRow = quieter(manyDesigns);
  return (
    <Harness
      designs={manyDesigns}
      openId="dsn_quieter"
      sidebar={sidebar}
      {...(filter ? { initialFilter: filter } : {})}
      chrome={(sidebarOpen) => (
        <DesignChromeHarness
          design={quieterRow}
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
  "team-sidebar": () => <DesignWindow />,
  "sidebar-team-menu": () => <DesignWindow />,
  "sidebar-filter": () => <DesignWindow />,
  "sidebar-search": () => <DesignWindow query="" />,
  "sidebar-search-results": () => <DesignWindow query="hero" />,
  share: () => <DesignWindow />,
  "share-not-joined": () => <DesignWindow members={f.membersMixed} />,
  "sidebar-previews-updating": () => <LivePreviews />,
  "thread-in-the-right-rail": () => (
    <DesignHarness
      designs={f.soloWorking}
      design={quieter(f.soloWorking)}
      contributors={f.justYou}
      thread={t.heroThread}
      agent={t.heroAgent}
      // As the boards go on: board 2's questions follow your next message.
      then={t.boardAsks}
    />
  ),
  "claude-sets-it-up": () => (
    <DesignHarness
      designs={[f.justCreated, ...f.soloDesigns]}
      design={f.justCreated}
      contributors={f.justYou}
      pages={f.onboardingPages}
      thread={t.setUpThread}
      agent={t.setUpAgent}
      changes={false}
    />
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
  "pick-a-project-scratch": () => (
    <Harness designs={f.soloDesigns} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} initialProject={{ kind: "scratch" }} />
    </Harness>
  ),
  "pick-a-project-one-repo": () => (
    <Harness designs={f.soloDesigns} openId={null}>
      <CreateHarness
        initialPrompt={ONBOARDING_PROMPT}
        initialProject={{ kind: "repo", repo: f.oneRepo[0]! }}
        repos={f.oneRepo}
      />
    </Harness>
  ),
  "pick-a-project-many-repos": () => (
    <Harness designs={f.soloDesigns} openId={null}>
      <CreateHarness initialPrompt={ONBOARDING_PROMPT} repos={f.manyRepos} />
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
  ...THREAD_BOARDS,
  ...SETUP_BOARDS,
};
