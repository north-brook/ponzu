/*
 * The cloud gallery: every board as a full window from fixtures, and every component's states.
 * Dev only: gallery.html is not part of the app's build. `?board=<id>` draws one composition,
 * `?states` the component states, `?ladder` the icon and text ladder, nothing the index; `&theme=light|dark` pins the scheme.
 */
import "../styles/cloud.css";
import { createRoot } from "react-dom/client";
import { NowContext } from "../time.ts";
import { quietPointerFocus } from "../ui/quiet-focus.ts";
import { BOARDS } from "./boards.tsx";
import { COMPOSITIONS } from "./compositions.ts";
import { NOW } from "./fixtures.ts";
import { Ladder } from "./ladder.tsx";
import { States } from "./states.tsx";

const params = new URLSearchParams(location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
quietPointerFocus();

function Index() {
  const link = (query: string) => `?${query}${theme ? `&theme=${theme}` : ""}`;
  return (
    <main className="h-full overflow-y-auto bg-canvas p-8">
      <h1 className="m-0 mb-6 font-display font-semibold text-34 tracking-[-0.02em]">
        Cloud gallery
      </h1>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-13">
        <li>
          <a href={link("states")} className="text-ink">
            Component states
          </a>
        </li>
        <li>
          <a href={link("ladder")} className="text-ink">
            The ladder
          </a>
        </li>
        {COMPOSITIONS.map((c) => (
          <li key={c.id}>
            <a href={link(`board=${c.id}`)} className="text-ink">
              {c.title}
            </a>
            <span className="text-faint">
              {" "}
              · {c.width}×{c.height}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}

const board = params.get("board");
const view = board ? (
  (BOARDS[board]?.() ?? <p>No board “{board}”.</p>)
) : params.has("states") ? (
  <States />
) : params.has("ladder") ? (
  <Ladder />
) : (
  <Index />
);

// The app's faces load before anything draws, so the first layout is the one that ships. Laid out
// in a fallback first, a component that measures itself once (page-tabs.tsx) keeps the fallback's
// size after the swap. Nothing caches the fonts between the gallery's pages.
await Promise.all(
  [
    '400 13px "Inter"',
    '600 13px "Inter"',
    'italic 400 13px "Inter"',
    '600 34px "Funnel Display"',
    '400 11px "IBM Plex Mono"',
    '500 11px "IBM Plex Mono"',
  ].map(
    // A face that won't load draws in its fallback; the gallery tests' fontsLoaded says so.
    (face) => document.fonts.load(face).catch(() => []),
  ),
);

createRoot(document.getElementById("root")!).render(
  <NowContext.Provider value={() => NOW}>{view}</NowContext.Provider>,
);

// The visual scripts wait for this before they draw.
document.fonts.ready.then(() => {
  (window as { galleryReady?: boolean }).galleryReady = true;
});
