import type { ReactNode } from "react";
import { Footer, Nav } from "@/components/chrome";
import { REPO } from "@/components/links";
import type { Os } from "@/components/platforms";
import { latestVersion } from "@/components/release";
import { AutoStart, Download } from "./download";

/** A link in an install page's fine print. */
export function FineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="text-ink underline decoration-outline underline-offset-4 hover:decoration-ink"
      href={href}
    >
      {children}
    </a>
  );
}

/**
 * A desktop's install page: the title and its one action, the drawn steps, and the fine print. With
 * `?start=1` (which every Download button sends) the download starts as the page opens.
 */
export async function Guide({
  os,
  started,
  title,
  lede,
  next,
  steps,
  fine,
}: {
  os: Os;
  started: boolean;
  title: string;
  lede: string;
  /** What to do once the download lands. */
  next: ReactNode;
  steps: ReactNode;
  /** The fine print, after the version. */
  fine: ReactNode;
}) {
  // The version only labels the fine print: the links always serve the newest release.
  const version = await latestVersion();
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      {started ? <AutoStart os={os} /> : null}
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-ink">
          {title}
        </h1>
        <p className="m-0 max-w-[560px] text-[19px]/[31px] text-balance text-muted">{lede}</p>
        <div className="flex flex-col items-center gap-2 pt-2">
          <Download os={os} started={started} next={next} />
        </div>
        <p className="m-0 text-sm text-faint">
          Not on this computer? <FineLink href="/download">Other downloads</FineLink>
        </p>
      </header>

      <section className="flex flex-col items-center">
        {steps}
        <p className="m-0 max-w-[640px] pt-14 text-center text-[13px]/[19px] text-pretty text-faint">
          {version ? `Version ${version} · ` : ""}
          {fine} Ponzu sets up Claude Code, Codex and Cursor on its own; for any other MCP client,
          File › Copy MCP URL copies the address. The source and every release are{" "}
          <FineLink href={REPO}>on GitHub</FineLink>.
        </p>
      </section>

      <Footer />
    </div>
  );
}
