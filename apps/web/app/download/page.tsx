import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer, Nav } from "@/components/chrome";
import { DownloadButton, OsIcon } from "@/components/download-button";
import { DownloadArrow, GitHub, PhoneIcon } from "@/components/icons";
import { REPO, TESTFLIGHT } from "@/components/links";
import { asset, OSES, type Os, PLATFORMS } from "@/components/platforms";
import { share } from "@/components/share";
import { CopyCommand } from "./copy-command";

const TITLE = "Download Ponzu";
const DESCRIPTION =
  "Ponzu for Mac, Windows and Linux: free and open source. It updates itself and sets up your agents on first launch.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  ...share({ path: "/download", title: TITLE, description: DESCRIPTION }),
};

/**
 * Every way to get Ponzu. The visitor's desktop is outlined, holds the dark button and comes first
 * (`[data-card]` in globals.css, picked before paint). Each card goes to its install steps, which
 * start the download; on a phone the buttons hand the link to a computer instead. Designed in
 * .context/windows-linux.design (Download pages › /download).
 */
export default function Page() {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-5 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-ink">
          Download Ponzu.
        </h1>
        <p className="m-0 max-w-[560px] text-[19px]/[31px] text-balance text-muted">
          Free and open source on Mac, Windows and Linux. It updates itself and sets up your agents
          on first launch.
        </p>
      </header>

      <section className="mx-auto flex max-w-[1200px] flex-col gap-5">
        <div className="grid grid-cols-3 gap-5 max-[1000px]:grid-cols-1">
          {OSES.map((os) => (
            <Card key={os} os={os} />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-5 max-[1000px]:grid-cols-1">
          {TESTFLIGHT ? (
            <Also
              href={TESTFLIGHT}
              icon={<PhoneIcon />}
              title={
                <>
                  iPhone <Beta />
                </>
              }
              body="Review and steer on the go"
              action="TestFlight →"
            />
          ) : null}
          <CopyCommand />
          <Also
            href={`${REPO}/releases`}
            icon={<GitHub />}
            title="Every release"
            body="Notes and older builds"
            action="GitHub →"
          />
        </div>
      </section>

      <Footer />
    </div>
  );
}

function Beta() {
  return (
    <span className="ml-1 rounded-full bg-yuzu px-[7px] py-0.5 align-[2px] text-[10.5px] font-bold text-[#111110]">
      BETA
    </span>
  );
}

const cta =
  "card-cta bg-ground text-ink shadow-[inset_0_0_0_1px_var(--outline)] hover:shadow-[inset_0_0_0_1px_var(--ink)]";

function Card({ os }: { os: Os }) {
  const p = PLATFORMS[os];
  const files = [p.file, p.alt].filter(Boolean) as string[];
  return (
    <div data-card={os} className="flex flex-col gap-[22px] rounded-3xl bg-tile p-8">
      <span className="text-[40px] text-ink">
        <OsIcon os={os} />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[26px] font-semibold tracking-[-0.02em] text-ink">
          {p.name}
          {p.beta ? <Beta /> : null}
        </h2>
        <p className="m-0 text-[15px] text-faint">{p.needs}</p>
      </div>
      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <DownloadButton os={os} className={cta}>
            {os === "linux" ? "AppImage" : "Download"}
          </DownloadButton>
          {p.alt ? (
            <a
              className="inline-flex items-center gap-[9px] rounded-full px-5 py-[15px] text-base font-semibold text-ink shadow-[inset_0_0_0_1px_var(--outline)] transition-[translate] duration-150 ease-out hover:-translate-y-px"
              href={asset(p.alt)}
            >
              <DownloadArrow />
              .deb
            </a>
          ) : null}
        </div>
        <span className="font-mono text-[13px] text-faint">{files.join(" · ")}</span>
      </div>
    </div>
  );
}

function Also({
  href,
  icon,
  title,
  body,
  action,
}: {
  href: string;
  icon: ReactNode;
  title: ReactNode;
  body: string;
  action: string;
}) {
  return (
    <a
      className="flex items-center gap-4 rounded-[18px] px-6 py-5 shadow-[inset_0_0_0_1px_var(--rule)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--outline)]"
      href={href}
    >
      <span className="text-[22px] text-ink">{icon}</span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        <span className="text-[13px] text-faint">{body}</span>
      </span>
      <span className="text-[13px] text-muted">{action}</span>
    </a>
  );
}
