import { Wedge } from "./icons";
import { DOCS, DownloadButton, REPO, SDK } from "./links";

export function Nav() {
  return (
    <nav className="flex items-center justify-between py-[22px]">
      <a
        className="flex items-center gap-2.5 text-[19px] font-bold tracking-[-0.04em] text-ink"
        href="/"
      >
        <Wedge size={28} />
        Ponzu
      </a>
      <div className="flex items-center gap-7 text-sm text-muted">
        <a className="hover:text-ink max-[720px]:hidden" href={DOCS}>
          Docs
        </a>
        <a className="hover:text-ink max-[720px]:hidden" href={REPO}>
          GitHub
        </a>
        <DownloadButton size="sm">Download</DownloadButton>
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="mt-24 flex w-full justify-between gap-4 border-t border-rule pt-7 pb-10 text-[13px] text-faint max-[720px]:flex-col">
      <span>© 2026 Ponzu · MIT</span>
      <span>
        <a className="hover:text-ink" href={DOCS}>
          Docs
        </a>{" "}
        ·{" "}
        <a className="hover:text-ink" href={REPO}>
          GitHub
        </a>{" "}
        ·{" "}
        <a className="hover:text-ink" href={SDK}>
          SDK
        </a>
      </span>
    </footer>
  );
}
