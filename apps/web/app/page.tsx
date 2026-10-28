import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AGENTS, AgentMark } from "@/components/agent-marks";
import { Footer, Nav } from "@/components/chrome";
import { Code, Diff, Tree } from "@/components/code";
import { CodeWell } from "@/components/code-well";
import { CssTileVisual } from "@/components/css-tile";
import { CommentThread } from "@/components/demo/comment-thread";
import { ProductDemo } from "@/components/demo/product-demo";
import { HomeScreen } from "@/components/home-screen";
import { Apple, Slice } from "@/components/icons";
import { IPhone } from "@/components/iphone";
import { DownloadButton, GitHubButton, TESTFLIGHT } from "@/components/links";
import { DESCRIPTION, share, TITLE } from "@/components/share";
import { SLICE_CSS } from "@/components/slice-demo";

const well =
  "m-0 overflow-hidden whitespace-pre rounded-[14px] px-5 py-4 font-mono text-[12.5px]/[22px]";
/** A code block: white on the light page, near-black on the dark one. */
const codeWell = `${well} code bg-well text-text shadow-[inset_0_0_0_1px_var(--well-rule)]`;

export const metadata: Metadata = share({
  path: "/",
  title: TITLE,
  description: DESCRIPTION,
  xDescription:
    "Your agent draws brands, apps and more in HTML and CSS on your Mac; you steer with comments.",
});

export default function Home() {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-14 pb-16 text-center md:pt-[104px]">
        {/* "open source" holds together once it fits: it's 352px at the smallest size. */}
        <h1 className="m-0 max-w-[1040px] font-display text-5xl leading-[1.02] font-semibold tracking-[-0.035em] text-balance text-ink sm:text-6xl md:text-7xl lg:text-8xl">
          The <span className="min-[400px]:whitespace-nowrap">open source</span> canvas for your
          agent.
        </h1>
        <p className="m-0 max-w-[760px] text-lg/[29px] text-balance text-muted md:text-[20px]/[32px]">
          Brands, apps, launch pages, diagrams, dashboards. Your agent draws them in HTML and CSS on
          your Mac, and you steer with comments.
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-3">
          <DownloadButton>Download for Mac</DownloadButton>
          <GitHubButton>View on GitHub</GitHubButton>
        </div>
      </header>

      {/*
        The demo on an ink desktop, with room on every side and its use cases along the top
        (`.demo-stage`).
      */}
      <div className="demo-stage relative mt-4 mb-28 overflow-hidden rounded-[28px] px-14 pt-11 pb-14 max-[720px]:rounded-2xl max-[720px]:p-4 max-[720px]:pt-5">
        <div className="dm-frame-host relative">
          <ProductDemo />
        </div>
      </div>

      {/*
        Three rows, each a wide tile beside a narrow one, flipped on the second row. Tiles in a row
        share a height, so each pair holds proofs of about the same size: a thread beside a diff, a
        grid of agents beside a stylesheet, the home screen beside the phone.
      */}
      <section className="grid gap-4 pb-[120px] md:grid-cols-12">
        <Tile
          className="md:col-span-12 lg:col-span-7"
          title="Steer with comments."
          body="Pin feedback anywhere. Your agent makes the change, resolves it and answers your questions."
        >
          <CommentThread />
        </Tile>

        <Tile
          className="md:col-span-6 lg:col-span-5"
          title="Designs you can commit."
          body="Every artboard is just an HTML file, so you can review it and commit it next to your code if you like."
        >
          <div className="flex flex-col gap-2">
            <CodeWell className={codeWell}>
              <Tree>{`fernwood.design/
├─ tokens.css
└─ pages/landing/sunroom.html`}</Tree>
            </CodeWell>
            <CodeWell className={codeWell}>
              <Diff
                lang="html"
                lines={[
                  "  <header>",
                  '+   <a class="drop">',
                  "+     The Autumn Drop",
                  "+   </a>",
                  "    <h1>Plants that…",
                ]}
              />
            </CodeWell>
          </div>
        </Tile>

        <Tile
          className="md:col-span-6 lg:col-span-5"
          title="Bring your agent."
          body="Claude Code, Codex, Cursor and any MCP client. No account."
        >
          <AgentsVisual />
        </Tile>

        <Tile
          className="md:col-span-12 lg:col-span-7"
          title="Just HTML and CSS."
          body="Grid, gradients, variable fonts, video and real animation."
        >
          <style>{SLICE_CSS}</style>
          <div className="grid flex-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div
              className={`${codeWell} flex min-h-[160px] items-center justify-center overflow-hidden py-0`}
            >
              <CssTileVisual />
            </div>
            <CodeWell className={`${codeWell} px-4 text-[11.5px]/[19px]`}>
              <Code code={SLICE_CSS} lang="css" />
            </CodeWell>
          </div>
        </Tile>

        <Tile
          className="md:col-span-12 lg:col-span-7"
          title="All your designs, on every Mac."
          body="Find designs across your Macs on Tailscale and watch your agent's edits live."
        >
          <HomeScreen />
        </Tile>

        <Tile
          id="iphone"
          className="scroll-mt-24 overflow-hidden pb-0 sm:pb-0 md:col-span-12 lg:col-span-5"
          title="And in your pocket."
          body={
            <>
              Cook with your agents on the go.{" "}
              {TESTFLIGHT ? (
                <a
                  className="inline-flex items-baseline gap-1.5 font-semibold whitespace-nowrap text-ink hover:underline"
                  href={TESTFLIGHT}
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
      </section>

      <section className="flex flex-col items-center gap-7 pt-10 pb-14 text-center">
        <a href="/" className="lockup" aria-label="Ponzu">
          <Slice size={72} className="[--slice:var(--yuzu)]" />
        </a>
        <h2 className="m-0 font-display text-4xl leading-[1.1] font-semibold tracking-[-0.03em] text-ink md:text-5xl lg:text-[56px]">
          Give your agent a canvas.
        </h2>
        <div className="flex flex-wrap justify-center gap-3 pt-3">
          <DownloadButton>Download for Mac</DownloadButton>
          <GitHubButton>View on GitHub</GitHubButton>
        </div>
      </section>

      <Footer />
    </div>
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

/** The agents Ponzu works with, and the commands that connect the ones it installs into. */
function AgentsVisual() {
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0">
        {AGENTS.map((agent) => (
          <li
            key={agent.id}
            title={agent.name}
            className="grid aspect-square place-items-center rounded-[14px] bg-well text-ink shadow-[inset_0_0_0_1px_var(--well-rule)]"
          >
            <AgentMark agent={agent.id} size={28} />
            <span className="sr-only">{agent.name}</span>
          </li>
        ))}
      </ul>
      <CodeWell className={`${codeWell} py-3.5 text-[12.5px]/[22px]`}>
        {["claude", "codex", "cursor"].map((agent) => (
          <span key={agent} className="block">
            <span className="text-[var(--sh-comment)]">$ </span>
            <span className="text-[var(--sh-fn)]">ponzu</span> install {agent}
          </span>
        ))}
      </CodeWell>
    </div>
  );
}
