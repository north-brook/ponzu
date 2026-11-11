/* The compositions of the thread rail, needs you and the pull request tab (compositions.ts). */
import type { ReactNode } from "react";
import type { AgentActivity, DesignSummary } from "../model.ts";
import { DesignHarness } from "./design-harness.tsx";
import * as f from "./fixtures.ts";
import * as t from "./thread-fixtures.ts";

export const WORKING: AgentActivity = { state: "working", status: null };
const WAITING: AgentActivity = { state: "needs_you", status: null };
const IDLE: AgentActivity = { state: "idle", status: null };

const QUIETER = "dsn_quieter";
const quieter = (designs: DesignSummary[]) => designs.find((d) => d.id === QUIETER)!;
/** Mac boards 2 and 3: the open design waits on two questions. */
const asking = f.soloDesigns.map((d) => (d.id === QUIETER ? { ...d, needsYou: 2 } : d));
const long = t.longThread();

export const THREAD_BOARDS: Record<string, () => ReactNode> = {
  "needs-you-a-question": () => (
    <DesignHarness
      designs={asking}
      design={quieter(asking)}
      contributors={f.justYou}
      thread={t.askingThread}
      agent={WAITING}
      asks={t.boardAsks}
    />
  ),
  "pull-request-tab": () => (
    <DesignHarness
      designs={asking}
      design={quieter(asking)}
      contributors={null}
      thread={t.askingThread}
      agent={WAITING}
      asks={t.boardAsks}
      pullRequest={{ kind: "ready", pr: t.pullRequest }}
      tab="pull-request"
    />
  ),
  "together-on-a-design": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={f.contributors}
      thread={t.teamThread}
      agent={WORKING}
    />
  ),
  "crowded-chrome": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={WORKING}
      action="update_branch"
    />
  ),
  "crowded-chrome-closed": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={WORKING}
      action="update_branch"
      rail={false}
    />
  ),
  "long-thread": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={f.justYou}
      thread={long.slice(-200)}
      olderThread={long.slice(0, -200)}
      agent={WORKING}
    />
  ),
  "thread-loading": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={f.justYou}
      thread={null}
      agent={IDLE}
    />
  ),
  "thread-every-kind": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={f.contributors}
      thread={t.everyKind}
      agent={WORKING}
    />
  ),
  "thread-read-only": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={f.contributors}
      thread={t.teamThread}
      agent={WORKING}
      gate={{ kind: "read_only", repo: f.fernwood }}
    />
  ),
  "pull-request-busy": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={{ ...quieter(f.soloDesigns), pullRequest: { ...f.pr412, state: "draft" } }}
      contributors={null}
      thread={t.heroThread}
      agent={WORKING}
      pullRequest={{ kind: "ready", pr: t.busyPullRequest }}
      tab="pull-request"
    />
  ),
  "pull-request-merged": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={{ ...quieter(f.soloDesigns), pullRequest: { ...f.pr412, state: "merged" } }}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{
        kind: "ready",
        pr: { ...t.pullRequest, state: "merged", endedAt: t.pullRequest.reviews[0]!.at },
      }}
      tab="pull-request"
    />
  ),
  "pull-request-one-file": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={{ ...quieter(f.soloDesigns), pullRequest: { ...f.pr412, state: "merged" } }}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{
        kind: "ready",
        pr: {
          ...t.pullRequest,
          state: "merged",
          head: "pz/320x200-card-with-the-word-hello",
          endedAt: t.pullRequest.reviews[0]!.at,
          checks: [],
          files: t.pullRequest.files.slice(0, 1),
          filesTotal: 1,
          additions: t.pullRequest.files[0]!.additions,
          deletions: t.pullRequest.files[0]!.deletions,
        },
      }}
      tab="pull-request"
    />
  ),
  "pull-request-loading": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={null}
      thread={t.heroThread}
      agent={WORKING}
      pullRequest={{ kind: "loading", summary: f.pr412 }}
      tab="pull-request"
    />
  ),
  "pull-request-error": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={null}
      thread={t.heroThread}
      agent={WORKING}
      pullRequest={{ kind: "error", summary: f.pr412 }}
      tab="pull-request"
    />
  ),
};
