import { NavDownload } from "./download-button";
import { GitHub, Lockup } from "./icons";
import { NAV, REPO } from "./links";
import { StickyBar } from "./sticky-bar";

export { Footer } from "./footer";

/**
 * The header. It stays at the top as you scroll: at rest it's the page's own top row, and once the
 * page moves a frosted inset bar fades in behind it, without moving anything (`.nav-bar` in
 * globals.css). Its links are NAV (links.tsx).
 */
export function Nav() {
  return (
    <StickyBar>
      <Lockup size={23} />
      <div className="flex items-center gap-7 text-sm text-muted">
        {NAV.map(({ label, href }) => (
          <a
            key={href}
            className="desktop-only flex items-center gap-2 hover:text-ink max-[720px]:hidden"
            href={href}
          >
            {href === REPO ? <GitHub /> : null}
            {label}
          </a>
        ))}
        {/* A phone can't run Ponzu: its header keeps GitHub, and the page's own button hands off. */}
        <a
          className="phone-only -mr-3 flex size-11 items-center justify-center text-[19px] hover:text-ink"
          href={REPO}
          aria-label="GitHub"
        >
          <GitHub />
        </a>
        <NavDownload className="desktop-only" />
      </div>
    </StickyBar>
  );
}
