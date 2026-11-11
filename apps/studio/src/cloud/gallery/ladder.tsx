/*
 * The ladder, drawn: each icon step at its size and stroke with the line it paints, the text
 * steps, the colour ladder, and how an icon and text pair in a control. `?ladder` in the gallery.
 */
import {
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  FolderLibraryIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Home01Icon,
  PlusSignIcon,
  Search01Icon,
  SidebarLeftIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Icon as CanvasIcon } from "@ponzu/canvas/icons";
import type { ReactNode } from "react";
import { Button, IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { ICON, type IconStep, TEXT } from "../ui/ladder.ts";
import { TipProvider } from "../ui/tooltip.tsx";

const STEPS: { step: IconStep; use: string; beside: string }[] = [
  {
    step: "control",
    use: "Alone in a 26–28px button; a canvas tool; leading a menu's row",
    beside: "—",
  },
  {
    step: "inline",
    use: "Inside a compact control beside 13px words: a tab, a check, a field",
    beside: "13px",
  },
  {
    step: "small",
    use: "Beside 12px words: a quiet button, the action button, a status line",
    beside: "12px",
  },
  {
    step: "meta",
    use: "Beside 11px words: the meta line, a header's chevron, a link's arrow",
    beside: "11px",
  },
  {
    step: "tick",
    use: "Inside a dense mark: a check that passed, a box's tick, a remove ✕",
    beside: "in a mark",
  },
];

const TEXTS: { name: keyof typeof TEXT; sample: string; tone?: string }[] = [
  { name: "body", sample: "Making the photo lead in B for Sam", tone: "text-ink" },
  { name: "name", sample: "Quieter shop hero", tone: "text-ink" },
  { name: "title", sample: "Northbrook", tone: "text-ink" },
  { name: "control", sample: "Opus 5.5 · fernwood", tone: "text-muted" },
  { name: "secondary", sample: "by brycedbjork · Oct 3", tone: "text-muted" },
  { name: "meta", sample: "fernwood · pz/hero-refresh · #412" },
  { name: "label", sample: "Repositories" },
];

const TONES: { name: string; token: string; use: string }[] = [
  { name: "primary", token: "text-ink", use: "What is read, chosen or open" },
  { name: "secondary", token: "text-muted", use: "A control at rest; a secondary line" },
  {
    name: "quiet icon",
    token: "text-icon-soft",
    use: "An icon standing alone, quietly: a chevron, a field's glyph (3:1)",
  },
  { name: "quiet", token: "text-faint", use: "Meta, placeholders, labels, counts" },
  {
    name: "disabled",
    token: "text-muted opacity-35",
    use: "Any of the above, faded: not a colour of its own",
  },
];

const ACCENTS: { name: string; token: string; use: string }[] = [
  { name: "yuzu", token: "text-yuzu", use: "The agent at work" },
  { name: "pr-open", token: "text-pr-open", use: "Open, passing" },
  { name: "pr-running", token: "text-pr-running", use: "Checks running" },
  { name: "pr-conflict", token: "text-pr-conflict", use: "Conflict" },
  { name: "pr-failing", token: "text-pr-failing", use: "Failing" },
  { name: "pr-merged", token: "text-pr-merged", use: "Merged" },
  { name: "danger", token: "text-danger", use: "Can't be undone; failed" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className={cn("m-0 uppercase tracking-[0.02em]", TEXT.label)}>{title}</h2>
      <div className="flex flex-col gap-px overflow-hidden rounded-12 bg-rule shadow-[0_0_0_1px_var(--c-rule)]">
        {children}
      </div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex min-h-12 items-center gap-6 bg-surface px-4 py-2.5">{children}</div>;
}

export function Ladder() {
  return (
    <TipProvider>
      <main className="h-full overflow-y-auto bg-canvas p-8 text-ink">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-8">
          <header className="flex flex-col gap-1.5">
            <h1 className="m-0 font-display font-semibold text-28 tracking-[-0.02em]">
              The ladder
            </h1>
            <p className="m-0 max-w-[640px] text-13 text-muted leading-[1.5]">
              Every icon and every piece of interface text is set from these steps, by name
              (ui/ladder.ts, @ponzu/canvas/ladder). An icon's stroke grows as it shrinks, so every
              step paints the same line.
            </p>
          </header>

          <Section title="Icons">
            {STEPS.map(({ step, use, beside }) => {
              const { size, stroke } = ICON[step];
              return (
                <Row key={step}>
                  <span className="w-20 font-medium font-mono text-12">{step}</span>
                  <span className="flex w-40 items-center gap-3 text-muted">
                    <Icon icon={SidebarLeftIcon} step={step} />
                    <Icon icon={Search01Icon} step={step} />
                    <Icon icon={GitBranchIcon} step={step} />
                    <Icon icon={Tick02Icon} step={step} />
                    <Icon icon={ArrowDown01Icon} step={step} />
                  </span>
                  <span className={cn("w-56", TEXT.meta)}>
                    {size}px · stroke {stroke} · paints {((stroke * size) / 24).toFixed(2)}px
                  </span>
                  <span className="w-16 text-12 text-faint">{beside}</span>
                  <span className="flex-1 text-12 text-muted">{use}</span>
                </Row>
              );
            })}
            <Row>
              <span className="w-20 font-medium font-mono text-12">on fill</span>
              <span className="flex w-40 items-center gap-3">
                <span className="grid size-7 place-items-center rounded-pill bg-yuzu text-yuzu-ink">
                  <Icon icon={ArrowUpRight01Icon} step="inline" onFill />
                </span>
                <span className="grid size-[15px] place-items-center rounded-4 bg-action text-action-ink">
                  <Icon icon={Tick02Icon} step="tick" onFill />
                </span>
              </span>
              <span className={cn("w-56", TEXT.meta)}>the step's stroke + 0.4</span>
              <span className="w-16" />
              <span className="flex-1 text-12 text-muted">
                Light on a solid ground reads thinner: the send arrow, the action button, a checked
                box
              </span>
            </Row>
          </Section>

          <Section title="Pairs in a control">
            <Row>
              <span className="w-56 text-12 text-muted">Alone in a 28px button (control)</span>
              <span className="flex items-center gap-1">
                <IconButton label="Toggle sidebar" className="size-7">
                  <Icon icon={SidebarLeftIcon} step="control" />
                </IconButton>
                <span className="flex items-center gap-0.5 rounded-10 bg-bar p-0.5 shadow-bar">
                  {(["select", "hand", "comment"] as const).map((n, i) => (
                    <span
                      key={n}
                      className={cn(
                        "grid size-7 place-items-center rounded-8",
                        i === 0 ? "bg-raised text-ink shadow-raised" : "text-muted",
                      )}
                    >
                      <CanvasIcon name={n} step="control" />
                    </span>
                  ))}
                </span>
                <span className="flex items-center gap-0.5 rounded-10 bg-bar p-0.5 text-muted shadow-bar">
                  <span className="grid size-[26px] place-items-center">
                    <CanvasIcon name="minus" step="control" />
                  </span>
                  <span className="min-w-9 text-center font-medium text-12 tabular-nums">100%</span>
                  <span className="grid size-[26px] place-items-center">
                    <CanvasIcon name="plus" step="control" />
                  </span>
                </span>
                <span className="ml-3 flex items-center gap-1.5 rounded-pill bg-surface py-1 pr-1 pl-1.5 shadow-bar">
                  <IconButton label="Attach an image" className="size-7 rounded-pill">
                    <Icon icon={PlusSignIcon} step="control" />
                  </IconButton>
                  <span className="w-32 text-13 text-faint">Steer, or ask more</span>
                  <span className="grid size-7 place-items-center rounded-pill bg-action">
                    <span className="size-[10px] rounded-2 bg-action-ink" />
                  </span>
                </span>
              </span>
            </Row>
            <Row>
              <span className="w-56 text-12 text-muted">Beside 13px words (inline)</span>
              <span className="flex h-7 items-center gap-1.5 rounded-8 bg-raised px-2.5 font-medium text-13 shadow-raised">
                <Icon icon={Home01Icon} step="inline" />
                Home
              </span>
              <span className="flex items-center gap-1.5 text-13 text-muted">
                <Icon icon={Tick02Icon} step="inline" />
                Everyone
              </span>
            </Row>
            <Row>
              <span className="w-56 text-12 text-muted">Beside 12px words (small)</span>
              <Button variant="quiet" className="gap-1.5 px-[9px]">
                <Icon icon={FolderLibraryIcon} step="small" />
                fernwood
                <Icon icon={ArrowDown01Icon} step="meta" />
              </Button>
              <Button variant="action">
                <Icon icon={GitPullRequestIcon} step="small" onFill />
                Create PR
              </Button>
            </Row>
            <Row>
              <span className="w-56 text-12 text-muted">The meta line (meta)</span>
              <span className={cn("flex items-center gap-1.5", TEXT.meta)}>
                <Icon icon={GitBranchIcon} step="meta" />
                pz/hero-refresh
                <Icon icon={GitPullRequestIcon} step="meta" />
                #412
              </span>
              <span className="flex items-center gap-1 font-mono text-11 text-muted">
                <Icon icon={GitPullRequestIcon} step="meta" />
                #412
                <Icon icon={Tick02Icon} step="tick" />
              </span>
            </Row>
          </Section>

          <Section title="Text">
            {TEXTS.map(({ name, sample, tone }) => (
              <Row key={name}>
                <span className="w-20 font-medium font-mono text-12">{name}</span>
                <span className={cn("w-80 truncate", TEXT[name], tone)}>{sample}</span>
                <span className={cn("flex-1", TEXT.meta)}>{TEXT[name]}</span>
              </Row>
            ))}
            <Row>
              <span className="w-20 font-medium font-mono text-12">display</span>
              <span className="w-80 truncate font-display font-semibold text-18">Members</span>
              <span className={cn("flex-1", TEXT.meta)}>
                Funnel Display 600: 34 create · 28 setup · 26 pull request · 18 a section · 40 a
                price
              </span>
            </Row>
          </Section>

          <Section title="Colour">
            {TONES.map(({ name, token, use }) => (
              <Row key={name}>
                <span className="w-20 font-medium font-mono text-12">{name}</span>
                <span className={cn("flex w-80 items-center gap-2 text-13", token)}>
                  <Icon icon={Search01Icon} step="control" />
                  <Icon icon={Cancel01Icon} step="inline" />
                  Pricing page
                </span>
                <span className={cn("w-40", TEXT.meta)}>{token}</span>
                <span className="flex-1 text-12 text-muted">{use}</span>
              </Row>
            ))}
            {ACCENTS.map(({ name, token, use }) => (
              <Row key={name}>
                <span className="w-20 font-medium font-mono text-12">{name}</span>
                <span className={cn("flex w-80 items-center gap-2 text-13", token)}>
                  <Icon icon={Tick02Icon} step="inline" />
                  <span className="size-2 rounded-pill bg-current" />
                </span>
                <span className={cn("w-40", TEXT.meta)}>{token}</span>
                <span className="flex-1 text-12 text-muted">{use}</span>
              </Row>
            ))}
          </Section>
        </div>
      </main>
    </TipProvider>
  );
}
