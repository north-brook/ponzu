import { SLICE, SLICE_STROKE } from "@ponzu/react/slice";
import { Heart, Lockup } from "./icons";
import { CONTRIBUTING, DOWNLOAD, IPHONE, LICENSE, PRIVACY, RELEASES, REPO, SDK } from "./links";

/**
 * The site footer. Its sign-off is a sunrise drawn in the mark: a field of tiny slices with a huge
 * one rising from the bottom edge in yuzu. The field fades in from the top and holds still. The
 * legal line sits on clearings of the page's ground that feather into it (`.field-clear`). See
 * `.field` in globals.css.
 */
export function Footer() {
  return (
    <footer className="mt-24 border-t border-rule pt-14">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-20 gap-y-10 max-md:grid-cols-2">
        <div className="flex flex-col gap-4 max-md:col-span-2">
          <Lockup size={22} />
          <p className="m-0 max-w-[300px] text-[15px]/[25px] text-pretty text-muted">
            The open source canvas for your agent.
          </p>
        </div>
        <FooterLinks
          title="Product"
          links={[
            ["Download", DOWNLOAD],
            ["Ponzu for iPhone", IPHONE],
            ["Releases", RELEASES],
            ["GitHub", REPO],
            ["Privacy", PRIVACY],
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

      <div className="relative -mx-16 mt-16 max-[720px]:-mx-5">
        <Field />
        {/* The legal line sits in the field, each part on a clearing of the page's own ground. */}
        <div className="absolute inset-x-0 bottom-0 flex justify-between gap-4 px-16 pb-5 text-[13px] text-muted max-[720px]:static max-[720px]:flex-col max-[720px]:gap-1.5 max-[720px]:px-5 max-[720px]:py-6">
          <a className="footer-link field-clear w-fit hover:text-ink" href="https://northbrook.com">
            © 2026 Northbrook PBC
          </a>
          <span className="field-clear flex w-fit items-center gap-[5px]">
            Made with
            <Heart className="fill-yuzu text-yuzu" />
            in Brooklyn NY
          </span>
        </div>
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

const CELL = 14;
const COLS = 103;
const ROWS = 22;
const W = COLS * CELL;
const H = ROWS * CELL;
/** The big slice: centred on the bottom edge, nearly the field's height, its gaps 13% of it. */
const R = H * 0.95;
const GAP = R * 0.13;

/** Whether a point falls inside one of the big slice's six segments. */
function inSlice(x: number, y: number) {
  const dx = x - W / 2;
  const dy = y - H;
  if (Math.hypot(dx, dy) > R) return false;
  // Each segment's two sides run along radii at -90° + 60°k, inset by half the gap.
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  const k = Math.floor((((a + 90) % 360) + 360) / 60) % 6;
  return [k, k + 1].every((side) => {
    const r = ((-90 + 60 * side) * Math.PI) / 180;
    return Math.abs(-Math.sin(r) * dx + Math.cos(r) * dy) >= GAP / 2;
  });
}

const UNITS = Array.from({ length: COLS * ROWS }, (_, n) => {
  const x = (n % COLS) * CELL + CELL / 2;
  const y = Math.floor(n / COLS) * CELL + CELL / 2;
  return { x, y, on: inSlice(x, y) };
});

/** The field, drawn once on the server: 2,266 units, each a <use> of one slice. */
function Field() {
  const unit = CELL * 0.88;
  return (
    <svg
      className="field h-[308px] max-[720px]:h-[200px]"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      <defs>
        <symbol id="field-unit" viewBox="0 0 64 64">
          <g
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={SLICE_STROKE}
            strokeLinejoin="round"
          >
            {SLICE.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
        </symbol>
      </defs>
      {UNITS.map(({ x, y, on }) => (
        <use
          key={`${x},${y}`}
          href="#field-unit"
          className="field-unit"
          data-on={on || undefined}
          x={x - unit / 2}
          y={y - unit / 2}
          width={unit}
          height={unit}
        />
      ))}
    </svg>
  );
}
