import { GitHub, Lockup } from "./icons";
import { DownloadButton, REPO } from "./links";
import { StickyBar } from "./sticky-bar";

export { Footer } from "./footer";

/**
 * The header. It stays at the top as you scroll: at rest it's the page's own top row, and once the
 * page moves a frosted inset bar fades in behind it, without moving anything (`.nav-bar` in
 * globals.css).
 */
export function Nav() {
  return (
    <StickyBar>
      <Lockup size={23} />
      <div className="flex items-center gap-7 text-sm text-muted">
        <a
          className="desktop-only flex items-center gap-2 hover:text-ink max-[720px]:hidden"
          href={REPO}
        >
          <GitHub />
          GitHub
        </a>
        {/* A phone can't run Ponzu: its header keeps GitHub, and the page's own button hands off. */}
        <a
          className="phone-only -mr-3 flex size-11 items-center justify-center text-[19px] hover:text-ink"
          href={REPO}
          aria-label="GitHub"
        >
          <GitHub />
        </a>
        <DownloadButton size="sm" className="desktop-only">
          Download
        </DownloadButton>
      </div>
    </StickyBar>
  );
}
