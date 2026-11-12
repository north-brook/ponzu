import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer, Nav } from "@/components/chrome";
import { Tree } from "@/components/code";
import { CodeWell } from "@/components/code-well";
import { DownloadSplit, PhonePlatforms } from "@/components/download-button";
import { HeroShot } from "@/components/hero-shot";
import { Apple, GitHub, Slice } from "@/components/icons";
import { IPhone } from "@/components/iphone";
import { IPHONE, PRICING, REPO, TESTFLIGHT } from "@/components/links";
import { PRICES } from "@/components/pricing";
import { DESCRIPTION, share, TITLE } from "@/components/share";
import { BILLING_LIVE } from "@/components/site";
import { Steps } from "@/components/steps";
import { WorkChips } from "@/components/work-chips";

const well =
  "m-0 overflow-hidden whitespace-pre rounded-[14px] px-5 py-4 font-mono text-[12.5px]/[22px]";
/** A code block: white on the light page, near-black on the dark one. */
const codeWell = `${well} code bg-well text-text shadow-[inset_0_0_0_1px_var(--well-rule)]`;

export const metadata: Metadata = share({
  path: "/",
  title: TITLE,
  description: DESCRIPTION,
});

export default function Home() {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-14 pb-14 text-center md:pt-[104px] md:pb-16">
        <h1 className="m-0 max-w-[1100px] font-display text-5xl leading-[1.02] font-semibold tracking-[-0.035em] text-balance text-ink sm:text-6xl md:text-7xl lg:text-8xl">
          Make it on the canvas. Ship it to your repo.
        </h1>
        <p className="m-0 max-w-[780px] text-lg/[29px] text-balance text-muted md:text-[20px]/[32px]">
          Ponzu runs Claude Code in the cloud, on your own Claude plan. Describe what you want,
          steer it with comments on a live canvas, and it lands as a pull request. Screens, flows,
          launch pages, dashboards, diagrams, whole features.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-3">
          <DownloadSplit testflight={TESTFLIGHT} />
          <a
            className="desktop-only inline-flex items-center gap-2 rounded-full px-5 py-[15px] text-base font-semibold text-ink hover:bg-chip"
            href={IPHONE}
          >
            <Apple className="size-[1em] fill-current" />
            Get it on iPhone
          </a>
        </div>
        <PhonePlatforms testflight={TESTFLIGHT} />
        <p className="m-0 text-sm text-faint">
          Free to start: {PRICES.freeCredits} credits a month.
        </p>
      </header>

      <HeroShot
        id="thread-in-the-right-rail"
        alt="The Ponzu window: boards on a canvas, the thread on the right."
        sizes="(min-width: 1440px) 1312px, (min-width: 721px) calc(100vw - 128px), calc(100vw - 40px)"
        priority
        className="mb-28 rounded-[18px] max-[720px]:mb-20 max-[720px]:rounded-[10px]"
      />

      <section className="flex flex-col gap-10 pb-28 max-[720px]:pb-20">
        <SectionHeading>From a sentence to a merge.</SectionHeading>
        <Steps />
      </section>

      {/*
        Three rows, each a wide tile beside a narrow one, flipped on the second row. Tiles in a
        row share a height, so each pair holds proofs of about the same size.
      */}
      <section className="grid gap-4 pb-28 max-[720px]:pb-20 md:grid-cols-12">
        <Tile
          className="md:col-span-12 lg:col-span-7"
          title="Steer with comments."
          body="Pin feedback on any board. Ponzu makes the change and tells you in a sentence; the detail is on the canvas."
        >
          <HeroShot
            id="together-on-a-canvas"
            alt="Comments pinned on three takes of a shop's hero, and the thread where Ponzu answers them."
            crop={{ x: 0.3, y: 0.4, w: 0.7, h: 0.57 }}
            sizes="(min-width: 1024px) 700px, 100vw"
            className="rounded-xl"
          />
        </Tile>

        <Tile
          className="md:col-span-12 lg:col-span-5"
          title="It ships as a pull request."
          body="One canvas, one branch, one pull request. Checks and reviews show in the pull request tab, and the next step is one button."
        >
          <HeroShot
            id="pull-request-tab"
            alt="A canvas's pull request tab: its checks passing, a review, and the Merge button."
            crop={{ x: 0.21, y: 0, w: 0.55, h: 0.62 }}
            sizes="(min-width: 1024px) 480px, 100vw"
            className="rounded-xl"
          />
        </Tile>

        <Tile
          className="md:col-span-6 lg:col-span-5"
          title="Full Claude Code, in the cloud."
          body="Your repo's CLAUDE.md, skills and MCP servers, a real dev server and your tests, in a sandbox of its own. It keeps going with your laptop closed, and sleeps when it's done."
        >
          <div className="flex flex-col gap-2">
            <CodeWell className={codeWell}>
              <Tree>{`fernwood/
├─ CLAUDE.md
├─ .claude/skills/
└─ .mcp.json`}</Tree>
            </CodeWell>
            <CodeWell className={codeWell}>
              <span className="text-[var(--sh-comment)]">$ </span>
              <span className="text-[var(--sh-fn)]">bun</span> dev
            </CodeWell>
          </div>
        </Tile>

        <Tile
          className="md:col-span-6 lg:col-span-7"
          title="Your team, on one canvas."
          body="Everyone with access to the repo sees the same canvas and thread, live. GitHub is the team: no seats, no invites."
        >
          <HeroShot
            id="team-sidebar"
            alt="A team's canvases in the sidebar, with the faces of who is in each, and the boards they share."
            crop={{ x: 0, y: 0, w: 0.64, h: 0.7 }}
            sizes="(min-width: 1024px) 700px, 100vw"
            className="rounded-xl"
          />
        </Tile>

        <Tile
          id="iphone"
          className="scroll-mt-24 overflow-hidden pb-0 sm:pb-0 md:col-span-6 lg:col-span-5"
          title="And in your pocket."
          body={
            <>
              Comment on canvases and answer Ponzu's questions from your iPhone.{" "}
              {TESTFLIGHT ? (
                <a
                  className="inline-flex items-baseline gap-1.5 font-semibold whitespace-nowrap text-ink hover:underline"
                  href={IPHONE}
                >
                  <Apple className="size-[0.95em] shrink-0 translate-y-[0.08em] fill-current" />
                  Join the beta
                </a>
              ) : (
                <span className="font-semibold text-ink">In beta on TestFlight.</span>
              )}
            </>
          }
        >
          <IPhone />
        </Tile>

        <Tile
          className="md:col-span-6 lg:col-span-7"
          title="Open source."
          body="MIT-licensed. Read exactly what runs in the sandbox and what touches your Claude account."
        >
          <div className="flex flex-col gap-3">
            <CodeWell className={codeWell}>
              <Tree>{`ponzu/
├─ apps/runner/   the sandbox
├─ apps/api/      the cloud
├─ apps/desktop/  the Mac app
└─ LICENSE        MIT`}</Tree>
            </CodeWell>
            <a
              className="inline-flex w-fit items-center gap-2 rounded-full bg-chip py-[11px] pr-5 pl-4 text-[15px] font-semibold text-text hover:bg-well"
              href={REPO}
            >
              <GitHub />
              Read the source
            </a>
          </div>
        </Tile>
      </section>

      <section className="flex flex-col items-center gap-10 pb-28 text-center max-[720px]:pb-20">
        <SectionHeading>One canvas, all kinds of work.</SectionHeading>
        <WorkChips />
        <p className="m-0 text-base text-muted">No repo? Start from Scratch.</p>
      </section>

      <section className="flex flex-col items-center gap-4 rounded-3xl bg-tile px-6 py-14 text-center sm:px-10">
        <SectionHeading>Pay for what runs.</SectionHeading>
        <p className="m-0 max-w-[620px] text-lg/[29px] text-balance text-muted">
          {PRICES.credit} a credit. An awake canvas uses {PRICES.creditsPerHour} credits an hour;
          asleep, nothing. {PRICES.freeCredits} credits a month on us, per person.
        </p>
        {BILLING_LIVE ? null : (
          <p className="m-0 text-sm text-faint">
            Ponzu is free while billing is being set up. We'll tell you before it starts.
          </p>
        )}
        <a
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-cta px-6 py-[13px] text-base font-semibold text-cta-ink"
          href={PRICING}
        >
          See pricing
          <span aria-hidden="true">→</span>
        </a>
      </section>

      <section className="flex flex-col items-center gap-7 pt-28 pb-14 text-center max-[720px]:pt-20">
        <a href="/" className="lockup" aria-label="Ponzu">
          <Slice size={72} className="[--slice:var(--yuzu)]" />
        </a>
        <h2 className="m-0 font-display text-4xl leading-[1.1] font-semibold tracking-[-0.03em] text-ink md:text-5xl lg:text-[56px]">
          Make something.
        </h2>
        <div className="flex flex-wrap justify-center gap-3 pt-3">
          <DownloadSplit testflight={TESTFLIGHT} />
        </div>
        <PhonePlatforms testflight={TESTFLIGHT} />
      </section>

      <Footer />
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="m-0 text-center font-display text-4xl leading-[1.1] font-semibold tracking-[-0.03em] text-balance text-ink md:text-5xl">
      {children}
    </h2>
  );
}

/** A bento cell: a short claim, then its proof, which grows to fill the rest of the tile. */
function Tile({
  id,
  title,
  body,
  className = "",
  children,
}: {
  id?: string;
  title: string;
  body: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={`flex min-w-0 flex-col gap-7 rounded-3xl bg-tile p-6 sm:p-8 ${className}`}
    >
      <div className="flex max-w-[480px] flex-col gap-2">
        <h2 className="m-0 font-display text-[26px]/[32px] font-semibold tracking-[-0.022em] text-ink md:text-[28px]/[34px]">
          {title}
        </h2>
        <p className="m-0 text-base/[26px] text-pretty text-muted">{body}</p>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center">{children}</div>
    </div>
  );
}
