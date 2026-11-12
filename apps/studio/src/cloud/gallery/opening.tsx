/*
 * A design opening with its answers late, on demand: the chrome as the app draws it while the
 * design's head, its document, presence and its pull request's read are still on their way.
 *
 * `known` is what the window has at the first paint: `row`, the sidebar's row (the design's
 * name, its repo and so its people's cluster, its pull request's number and state, and so the
 * action it most likely offers, whose room is held); `nothing`, a launch, before the row.
 * Everything else arrives when the page calls `window.galleryArrive(part)`:
 *
 * - `pages`, `people`, `title`, `pull-request`: the document's pages, the others in it, the
 *   name and the mark (the last two only with `known: nothing`);
 * - `action` the read's action, or `action:<kind>` another, `action:none` none (it leaves);
 * - `switch`: another design opens (the chrome made anew, as the app's is), its row known;
 * - `everything`: all of them at once.
 *
 * `?later` delivers them on a schedule a person can watch, each at a time a slow network gives.
 */
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import type { Contributor, DesignSummary } from "../model.ts";
import { type NextAction, nextAction } from "../pull-request.ts";
import { railSignal } from "../status.ts";
import { DesignChrome } from "../window/design-chrome.tsx";
import * as f from "./fixtures.ts";
import { Harness } from "./harness.tsx";

const ignore = () => {};

type Part = "pages" | "people" | "title" | "pull-request" | "action";

/** When `?later` delivers each part, in ms from the first paint. */
const LATER: Record<Part, number> = {
  title: 250,
  pages: 400,
  "pull-request": 550,
  people: 700,
  action: 1300,
};

declare global {
  interface Window {
    galleryArrive?: (part: string) => void;
  }
}

export function OpeningWindow({
  known,
  sidebar = "open",
}: {
  known: "row" | "nothing";
  sidebar?: "open" | "closed";
}) {
  const [designId, setDesignId] = useState("dsn_quieter");
  const design = f.teamDesigns.find((d) => d.id === designId)!;
  const [arrived, setArrived] = useState<Set<Part>>(new Set());
  // The action the read says, once it has: its own kind, or another, or none.
  const [action, setAction] = useState<NextAction | null | undefined>(undefined);
  const [rail, setRail] = useState(true);
  useEffect(() => {
    const arrive = (part: string) => {
      if (part === "switch") {
        setDesignId((id) => (id === "dsn_quieter" ? "dsn_pricing" : "dsn_quieter"));
        setArrived(new Set());
        setAction(undefined);
        return;
      }
      if (part === "everything") {
        setArrived(new Set(Object.keys(LATER) as Part[]));
        return;
      }
      if (part.startsWith("action:")) {
        const kind = part.slice("action:".length);
        setAction(kind === "none" ? null : (kind as NextAction));
      }
      setArrived((now) => new Set([...now, part.split(":")[0] as Part]));
    };
    // In one commit, before the call returns: a test steps the movement it starts at once.
    window.galleryArrive = (part) => flushSync(() => arrive(part));
    if (!new URLSearchParams(location.search).has("later")) return;
    const timers = (Object.entries(LATER) as [Part, number][]).map(([part, ms]) =>
      setTimeout(() => arrive(part), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  const has = (part: Part) => arrived.has(part);
  const rowKnown = known === "row";
  const pr = rowKnown || has("pull-request") ? design.pullRequest : null;
  // The read's action: `action` alone is the design's own, as its pull request offers.
  const read = has("action")
    ? action === undefined
      ? nextAction(design.pullRequest, true)
      : action
    : undefined;
  const people: Contributor[] = has("people") ? f.contributors : f.justYou;
  return (
    <Harness
      designs={f.teamDesigns}
      openId={designId}
      sidebar={sidebar}
      rail={rail}
      chrome={(sidebarOpen) =>
        openingChrome({
          design,
          sidebarOpen,
          known: rowKnown || has("title"),
          team: rowKnown || has("people"),
          people,
          pages: has("pages"),
          pr,
          action: read,
          rail,
          onToggleRail: () => setRail((o) => !o),
        })
      }
    >
      {null}
    </Harness>
  );
}

/** The chrome as the app's slot draws it from what has arrived; made anew for each design. */
function openingChrome(props: {
  design: DesignSummary;
  sidebarOpen: boolean;
  known: boolean;
  team: boolean;
  people: Contributor[];
  pages: boolean;
  pr: DesignSummary["pullRequest"];
  action: NextAction | null | undefined;
  rail: boolean;
  onToggleRail: () => void;
}) {
  const { design } = props;
  const expected =
    props.action === undefined &&
    props.pr &&
    (props.pr.state === "open" || props.pr.state === "draft")
      ? nextAction(props.pr, false)
      : null;
  return (
    <DesignChrome
      key={design.id}
      name={props.known ? design.name : ""}
      sidebarOpen={props.sidebarOpen}
      pages={props.pages ? f.homePages : []}
      activePageId={props.pages ? f.homePages[0]!.id : null}
      onSelectPage={ignore}
      onAddPage={props.pages ? ignore : null}
      team={
        props.team && design.project.kind === "repo"
          ? {
              meId: f.bryce.id,
              contributors: props.people,
              repo: design.project.repo,
              members: f.members,
              onOpenRepo: ignore,
            }
          : null
      }
      pullRequest={props.pr ? { pr: props.pr, tabOpen: false, onToggleTab: ignore } : null}
      action={props.action ? { kind: props.action, onRun: ignore } : null}
      actionExpected={expected}
      rail={{ open: props.rail, signal: railSignal(design, false), onToggle: props.onToggleRail }}
    />
  );
}
