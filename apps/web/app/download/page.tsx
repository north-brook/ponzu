import type { Metadata } from "next";
import { Footer, Nav } from "@/components/chrome";
import { REPO } from "@/components/links";
import { latestVersion } from "@/components/release";
import { AutoStart, Download } from "./download";
import { Steps } from "./steps";

export const metadata: Metadata = {
  title: "Download Ponzu for Mac",
  description:
    "Install Ponzu for Mac: open the disk image, drag it into Applications, and connect your agent.",
  alternates: { canonical: "/download" },
};

/** The DMG keeps one name across versions (apps/desktop/package.json, dmg.artifactName). */
const INSTALLER = "Ponzu-arm64.dmg";
/** What the app serves while it runs; File › Copy MCP URL copies the actual one. */
const MCP_URL = "http://127.0.0.1:7777/mcp";

// The version only labels the fine print: the DMG link always serves the newest release.
export default async function Page(props: PageProps<"/download">) {
  const [version, query] = await Promise.all([latestVersion(), props.searchParams]);
  const started = query.start === "1";

  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      {started ? <AutoStart /> : null}
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.02] font-medium tracking-[-0.04em] text-balance text-ink">
          Ponzu for Mac.
        </h1>
        <p className="m-0 max-w-[560px] text-[19px]/[29px] text-balance text-muted">
          Download it, drag it into Applications, and point your agent at the canvas.
        </p>
        <div className="pt-2">
          <Download installer={INSTALLER} started={started} />
        </div>
      </header>

      <section className="flex flex-col items-center">
        <Steps installer={INSTALLER} url={MCP_URL} />
        <p className="m-0 max-w-[640px] pt-14 text-center text-[13px]/[19px] text-pretty text-faint">
          {version ? `Version ${version} · ` : ""}Signed by Northbrook and notarized by Apple. If
          macOS asks whether you are sure you want to open an app downloaded from the internet,
          choose Open. Updates install themselves. File › Copy MCP URL copies the address your agent
          needs; any MCP client works. The source and every release are{" "}
          <a
            className="text-ink underline decoration-outline underline-offset-4 hover:decoration-ink"
            href={REPO}
          >
            on GitHub
          </a>
          .
        </p>
        <Footer />
      </section>
    </div>
  );
}
