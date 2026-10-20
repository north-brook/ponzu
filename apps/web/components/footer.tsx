import { Wedge } from "./icons";
import { CONTRIBUTING, DOWNLOAD, LICENSE, RELEASES, REPO, SDK } from "./links";

/**
 * The site footer. Its sign-off is a citrus sunrise: half a ponzu wheel resting on the horizon
 * line, its segments doubling as rays. It rises a few pixels as the page reaches its end, a quiet
 * note that the last section is a beginning. See `.horizon` in globals.css.
 */
export function Footer() {
  return (
    <footer className="mt-24 border-t border-rule pt-14">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-20 gap-y-10 max-md:grid-cols-2">
        <div className="flex flex-col gap-4 max-md:col-span-2">
          <a
            className="flex w-fit items-center gap-2.5 text-[19px] font-bold tracking-[-0.03em] text-ink"
            href="/"
          >
            <Wedge size={28} />
            Ponzu
          </a>
          <p className="m-0 max-w-[300px] text-[15px]/[25px] text-pretty text-muted">
            The design canvas for your coding agent.
          </p>
        </div>
        <FooterLinks
          title="Product"
          links={[
            ["Download for Mac", DOWNLOAD],
            ["Releases", RELEASES],
            ["GitHub", REPO],
          ]}
        />
        <FooterLinks
          title="Build"
          links={[
            ["React SDK", SDK],
            ["Contributing", CONTRIBUTING],
            ["MIT License", LICENSE],
          ]}
        />
      </div>

      <div className="horizon mt-24 max-md:mt-16">
        <svg className="horizon-sun" viewBox="0 0 100 50" aria-hidden="true">
          <path fill="var(--rind)" d="M2 50A48 48 0 0 1 98 50Z" />
          <path fill="var(--pith)" d="M7 50A43 43 0 0 1 93 50Z" />
          <path fill="var(--flesh)" d="M10 50A40 40 0 0 1 90 50Z" />
          <path
            stroke="var(--pith)"
            strokeWidth="2.6"
            strokeLinecap="round"
            fill="none"
            d="M50 50L15.36 30M50 50L30 15.36M50 50L50 10M50 50L70 15.36M50 50L84.64 30"
          />
        </svg>
      </div>

      <div className="flex justify-between gap-4 py-7 text-[13px] text-faint max-[720px]:flex-col max-[720px]:gap-1.5">
        <a className="footer-link w-fit hover:text-muted" href="https://northbrook.com">
          © 2026 Northbrook PBC
        </a>
        <span>Free and open source, MIT licensed</span>
      </div>
    </footer>
  );
}

function FooterLinks({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div className="flex flex-col gap-3 text-[15px]">
      <h3 className="m-0 text-[13px] font-medium text-faint">{title}</h3>
      {links.map(([label, href]) => (
        <a key={label} className="footer-link w-fit text-muted hover:text-ink" href={href}>
          {label}
        </a>
      ))}
    </div>
  );
}
