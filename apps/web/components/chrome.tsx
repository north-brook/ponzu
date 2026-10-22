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
        <a className="flex items-center gap-2 hover:text-ink max-[720px]:hidden" href={REPO}>
          <GitHub />
          GitHub
        </a>
        <DownloadButton size="sm">Download</DownloadButton>
      </div>
    </StickyBar>
  );
}
