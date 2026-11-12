/* Every component in every state it has, one section each. */
import { GitMergeIcon } from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { NewCanvasComposer } from "../create/composer.tsx";
import { type CanvasFilter, NO_FILTER, projectCounts, repoKey } from "../filter.ts";
import type { CanvasSummary, Effort, PullRequestSummary } from "../model.ts";
import { type NextAction, nextAction } from "../pull-request.ts";
import { CanvasList, CanvasListSkeleton } from "../sidebar/canvas-list.tsx";
import { FilterMenu } from "../sidebar/filter-menu.tsx";
import { SearchResultsView } from "../sidebar/search.tsx";
import { WorkspaceMenu } from "../sidebar/workspace-menu.tsx";
import { type RailSignal, railSignal } from "../status.ts";
import { Avatar, AvatarStack } from "../ui/avatar.tsx";
import { Button, IconButton, SendButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { Kbd } from "../ui/kbd.tsx";
import { Checkbox } from "../ui/menu.tsx";
import { TipProvider } from "../ui/tooltip.tsx";
import { NextActionButton } from "../window/next-action.tsx";
import { PageTabs } from "../window/page-tabs.tsx";
import { PullRequestMark, PullRequestTab } from "../window/pull-request-mark.tsx";
import { ThreadToggle } from "../window/thread-toggle.tsx";
import * as f from "./fixtures.ts";
import { CreateHarness } from "./harness.tsx";
import { SetupStates } from "./setup-states.tsx";
import { ThreadStates } from "./thread-states.tsx";

const ignore = () => {};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 font-semibold text-13 text-muted">{title}</h2>
      <div className="flex flex-wrap items-start gap-6 rounded-10 bg-chrome p-4">{children}</div>
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      {children}
      <span className="text-11 text-faint">{label}</span>
    </div>
  );
}

const PRS: [string, PullRequestSummary][] = [
  ["Draft", { number: 412, state: "draft", checks: "none", mergeable: null, autoMerge: false }],
  [
    "Checks running",
    { number: 412, state: "open", checks: "running", mergeable: null, autoMerge: false },
  ],
  [
    "A check failing",
    { number: 412, state: "open", checks: "failing", mergeable: true, autoMerge: false },
  ],
  [
    "Conflicts",
    { number: 412, state: "open", checks: "passing", mergeable: false, autoMerge: false },
  ],
  ["Ready", f.pr412],
  [
    "Merged",
    { number: 412, state: "merged", checks: "passing", mergeable: true, autoMerge: false },
  ],
  ["Closed", { number: 412, state: "closed", checks: "none", mergeable: null, autoMerge: false }],
];

const ACTIONS: NextAction[] = [
  "create_pr",
  "ready",
  "auto_merge",
  "auto_merge_on",
  "fix_checks",
  "resolve",
  "merge",
];

const SIGNALS: [string, RailSignal, boolean][] = [
  ["Closed · idle", "idle", false],
  ["Closed · unseen", "unseen", false],
  ["Closed · working", "working", false],
  ["Closed · needs you", { needsYou: 2 }, false],
  ["Open", { needsYou: 2 }, true],
];

const base = f.teamCanvases[4]!;
const ROWS: CanvasSummary[] = [
  { ...base, id: "s_idle", name: "Nothing new" },
  { ...base, id: "s_unseen", name: "Unseen activity", unseen: true },
  { ...base, id: "s_working", name: "Working", agentState: "working", unseen: true },
  {
    ...base,
    id: "s_needs",
    name: "Needs you (outranks working)",
    needsYou: 3,
    agentState: "working",
  },
  {
    ...base,
    id: "s_pr",
    name: "With a pull request, open",
    pullRequest: f.pr412,
    hereNow: [f.sam, f.maya, f.jordan],
  },
  {
    ...base,
    id: "s_long",
    name: "A canvas with a name far too long to fit in the sidebar's row",
    project: {
      kind: "repo",
      repo: f.fernwood,
      branch: "pz/a-very-long-branch-name-that-overflows",
    },
    pullRequest: { ...f.pr412, number: 12873 },
  },
  {
    ...base,
    id: "s_scratch",
    name: "Scratch",
    project: { kind: "scratch", city: "lisbon" },
    preview: null,
  },
];

function FilterDemo() {
  const [filter, setFilter] = useState<CanvasFilter>({
    person: null,
    projects: [repoKey(f.fernwood)],
  });
  return (
    <FilterMenu
      filter={filter}
      onChange={setFilter}
      me={f.ada}
      teammates={f.teammates}
      projects={projectCounts(f.teamCanvases)}
    />
  );
}

function ComposerDemo({ initial, sending }: { initial: string; sending?: boolean }) {
  const [prompt, setPrompt] = useState(initial);
  return (
    <div className="w-[520px]">
      <NewCanvasComposer
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={ignore}
        onAttach={ignore}
        sending={sending}
        model={{
          models: f.models,
          efforts: ["low", "high", "max"],
          model: f.models[0]!.id,
          effort: "high",
          onChange: ignore,
        }}
      />
    </div>
  );
}

/**
 * The picker on what an account's Claude Code reported: a model Ponzu has never heard of under
 * Claude Code's own name, and one that takes fewer efforts. Pick it to see its efforts.
 */
function ReportedModelsDemo() {
  const [prompt, setPrompt] = useState("");
  const [choice, setChoice] = useState<{ model: string; effort: Effort }>({
    model: "claude-opus-6",
    effort: "medium",
  });
  return (
    <div className="w-[520px]">
      <NewCanvasComposer
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={ignore}
        onAttach={ignore}
        model={{
          models: f.reportedModels,
          efforts: ["low", "medium", "high", "xhigh", "max"],
          ...choice,
          onChange: (model, effort) => setChoice({ model, effort }),
        }}
      />
    </div>
  );
}

export function States() {
  return (
    <TipProvider>
      <main className="flex h-full flex-col gap-8 overflow-y-auto bg-canvas p-8">
        <h1 className="m-0 font-display font-semibold text-34 tracking-[-0.02em]">
          Component states
        </h1>

        <Section title="Buttons">
          {ACTIONS.map((a) => (
            <Labelled key={a} label={a}>
              <NextActionButton action={a} onRun={ignore} />
            </Labelled>
          ))}
          <Labelled label="busy">
            <NextActionButton action="merge" busy onRun={ignore} />
          </Labelled>
          <Labelled label="quiet">
            <Button variant="quiet" className="px-2.5">
              fernwood
            </Button>
          </Labelled>
          <Labelled label="icon">
            <IconButton label="Merge" className="size-7">
              <Icon icon={GitMergeIcon} step="control" />
            </IconButton>
          </Labelled>
          <Labelled label="icon, disabled">
            <IconButton label="Merge" disabled className="size-7">
              <Icon icon={GitMergeIcon} step="control" />
            </IconButton>
          </Labelled>
          <Labelled label="send">
            <SendButton size={32} />
          </Labelled>
          <Labelled label="send, disabled">
            <SendButton size={32} disabled />
          </Labelled>
          <Labelled label="send, rail">
            <SendButton size={28} />
          </Labelled>
        </Section>

        <Section title="Thread toggle">
          {SIGNALS.map(([label, signal, open]) => (
            <Labelled key={label} label={label}>
              <ThreadToggle open={open} signal={signal} onToggle={ignore} />
            </Labelled>
          ))}
          <Labelled label="from a canvas that needs you">
            <ThreadToggle
              open={false}
              signal={railSignal(f.teamCanvases[0]!, true)}
              onToggle={ignore}
            />
          </Labelled>
        </Section>

        <Section title="Pull request mark and next action">
          {PRS.map(([label, pr]) => {
            const action = nextAction(pr, true);
            return (
              <Labelled key={label} label={label}>
                <PullRequestTab pr={pr} active={false} onToggle={ignore} />
                <PullRequestTab pr={pr} active onToggle={ignore} />
                <span className="text-faint">
                  <PullRequestMark pr={pr} tone="neutral" checks={false} />
                </span>
                {action ? (
                  <NextActionButton action={action} onRun={ignore} />
                ) : (
                  <span className="text-11 text-faint">no action</span>
                )}
              </Labelled>
            );
          })}
        </Section>

        <Section title="Page tabs">
          <div className="w-[520px]" data-state="one page">
            <PageTabs
              pages={[{ id: "pg_1", name: "Page 1", icon: null, working: false }]}
              activeId="pg_1"
              onSelect={ignore}
              onAdd={ignore}
            />
          </div>
          <div className="flex w-[300px]" data-state="too many to fit">
            <PageTabs
              pages={[
                ...f.homePages,
                { id: "x", name: "Checkout", icon: null, working: false },
                { id: "y", name: "Empty states", icon: "list", working: false },
              ]}
              activeId="pg_product"
              onSelect={ignore}
              onAdd={ignore}
            />
          </div>
          <div className="w-[520px]" data-state="three pages">
            <PageTabs pages={f.homePages} activeId="pg_product" onSelect={ignore} onAdd={ignore} />
          </div>
          <div className="w-[520px]">
            <PageTabs
              pages={[
                ...f.homePages,
                { id: "w", name: "Working", icon: "phone", working: true },
                { id: "x", name: "Checkout", icon: null, working: false },
                { id: "y", name: "Empty states", icon: "list", working: false },
              ]}
              activeId="pg_product"
              onSelect={ignore}
              onAdd={ignore}
            />
          </div>
        </Section>

        <Section title="Canvas rows">
          <div className="w-[284px]">
            <CanvasList
              canvases={ROWS}
              openId="s_pr"
              label="States"
              onOpen={ignore}
              onAction={ignore}
              onRename={ignore}
            />
          </div>
          <div className="w-[284px]">
            <CanvasListSkeleton />
          </div>
        </Section>

        <Section title="Menus">
          <WorkspaceMenu
            current={f.thistlewick}
            workspaces={f.workspaces}
            onSwitch={ignore}
            onAddWorkspace={ignore}
            onSettings={ignore}
            onPlan={ignore}
            onSignOut={ignore}
          />
          <WorkspaceMenu
            current={f.personal}
            workspaces={[f.personal]}
            onSwitch={ignore}
            onAddWorkspace={ignore}
            onSettings={ignore}
            onPlan={ignore}
            onSignOut={ignore}
          />
          <Labelled label="filter on">
            <FilterDemo />
          </Labelled>
          <Labelled label="filter, personal">
            <FilterMenu
              filter={NO_FILTER}
              onChange={ignore}
              me={f.ada}
              teammates={null}
              projects={projectCounts(f.soloCanvases)}
            />
          </Labelled>
          <Labelled label="checkbox">
            <span className="flex gap-2">
              <Checkbox checked />
              <Checkbox checked={false} />
            </span>
          </Labelled>
        </Section>

        <Section title="Search">
          <div className="flex w-[284px] flex-col">
            <SearchResultsView
              query="hero"
              results={f.heroResults}
              selected="board:ab_hero_b"
              onSelect={ignore}
              onOpenResult={ignore}
            />
          </div>
          <div className="flex w-[284px] flex-col">
            <SearchResultsView
              query="zebra"
              results={{ query: "zebra", canvases: [], boards: [], comments: [] }}
              selected={null}
              onSelect={ignore}
              onOpenResult={ignore}
            />
          </div>
        </Section>

        <Section title="Avatars and keys">
          <Avatar person={f.maya} size={26} />
          <Avatar person={{ ...f.maya, avatarUrl: null }} size={26} />
          <AvatarStack people={[f.sam, f.maya, f.jordan]} size={15} overlap={5} ring="chrome" />
          <Kbd>⌘,</Kbd>
          <Kbd>esc</Kbd>
        </Section>

        <Section title="Composer">
          <ComposerDemo initial="" />
          <ComposerDemo initial="Three takes on the hero" />
          <ComposerDemo initial="Three takes on the hero" sending />
          <ReportedModelsDemo />
        </Section>

        <Section title="Create page in a pane">
          <div className="relative h-[560px] w-[900px] overflow-hidden rounded-10 bg-canvas">
            <CreateHarness ideas={f.ideas} />
          </div>
        </Section>

        <ThreadStates Section={Section} />
        <SetupStates
          section={(title, children) => (
            <Section key={title} title={title}>
              {children}
            </Section>
          )}
        />
      </main>
    </TipProvider>
  );
}
