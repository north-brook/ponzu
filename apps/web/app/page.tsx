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
import { Slice } from "@/components/icons";
import { DownloadButton, GitHubButton } from "@/components/links";
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
    "Open source and local. Your agent designs in HTML and CSS; you steer with comments.",
});

export default function Home() {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-14 pb-16 text-center md:pt-[104px]">
        <h1 className="m-0 max-w-[1040px] font-display text-5xl leading-[1.02] font-semibold tracking-[-0.035em] text-balance text-ink sm:text-6xl md:text-7xl lg:text-8xl">
          The design canvas for your coding agent.
        </h1>
        <p className="m-0 max-w-[620px] text-lg/[29px] text-pretty text-muted md:text-[20px]/[32px]">
          Open source. Runs on your machine. Your agent designs in plain HTML and CSS, and you steer
          with comments.
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-3">
          <DownloadButton>Download for Mac</DownloadButton>
          <GitHubButton>GitHub</GitHubButton>
        </div>
      </header>

      {/* The demo on a yuzu desktop, with room on every side. The big slice behind it holds still. */}
      <div className="relative mt-4 mb-28 overflow-hidden rounded-[28px] bg-yuzu p-14 max-[720px]:rounded-2xl max-[720px]:p-4">
        <Slice
          size={620}
          className="pointer-events-none absolute -top-[200px] -right-[180px] opacity-[0.12] [--slice:#111110] max-[720px]:hidden"
        />
        <div className="dm-frame-host relative">
          <ProductDemo />
        </div>
      </div>

      {/*
        Two rows, each a wide tile beside a narrow one, flipped on the second row, then the home
        screen across the full width. Tiles in a row share a height, so each pair holds proofs of
        about the same size: a thread beside a diff, a grid of agents beside a stylesheet.
      */}
      <section className="grid gap-4 pb-[120px] md:grid-cols-12">
        <Tile
          className="md:col-span-12 lg:col-span-7"
          title="Steer with comments."
          body="Pin feedback anywhere on the canvas. Your agent makes the change and resolves it, and answers when you ask a question."
        >
          <CommentThread />
        </Tile>

        <Tile
          className="md:col-span-6 lg:col-span-5"
          title="Designs you can commit."
          body="Every artboard is an HTML file. Review changes in git, next to your code."
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
          body="Grid, gradients, variable fonts, video and animation: the browser's own building blocks."
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
          className="md:col-span-12"
          title="Every design on your Macs."
          body="Ponzu's home screen lists every .design on this Mac and your others on Tailscale, grouped by project and branch, with live previews of whatever your agent is working on."
        >
          <HomeScreen />
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
  title,
  body,
  className = "",
  children,
}: {
  title: string;
  body: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-7 rounded-3xl bg-tile p-6 sm:p-8 ${className}`}>
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
