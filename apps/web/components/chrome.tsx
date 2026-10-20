import { GitHub, Wedge } from "./icons";
import { DownloadButton, REPO } from "./links";

export { Footer } from "./footer";

export function Nav() {
  return (
    <nav className="flex items-center justify-between py-[22px]">
      <a
        className="flex items-center gap-2.5 text-[19px] font-bold tracking-[-0.03em] text-ink"
        href="/"
      >
        <Wedge size={28} />
        Ponzu
      </a>
      <div className="flex items-center gap-7 text-sm text-muted">
        <a className="flex items-center gap-2 hover:text-ink max-[720px]:hidden" href={REPO}>
          <GitHub />
          GitHub
        </a>
        <DownloadButton size="sm">Download</DownloadButton>
      </div>
    </nav>
  );
}
