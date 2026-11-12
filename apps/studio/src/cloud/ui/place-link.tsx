import { createContext, type MouseEvent, type ReactNode, useContext } from "react";
import type { CanvasAddress } from "./canvas-address.ts";
import { Tip } from "./tooltip.tsx";

/**
 * What lets a link in Prose to a design's own address (canvas-address.ts) go there in place:
 * the thread of an open design provides it. Without it (a pull request's tab) such a link is an
 * ordinary one.
 */
export interface CanvasPlaces {
  /** The open design's id. */
  canvasId: string;
  /**
   * Whether a page or board of the open design is there now: true, false once it is known not
   * to be (deleted, or an id that never was), undefined while the design is still loading.
   */
  has(at: { page?: string; artboard?: string }): boolean | undefined;
  /** Shows the place: on this design's canvas, or by opening the design it is in. */
  open(at: CanvasAddress): void;
}

const Places = createContext<CanvasPlaces | null>(null);

export function CanvasPlacesProvider({
  value,
  children,
}: {
  value: CanvasPlaces;
  children: ReactNode;
}) {
  return <Places.Provider value={value}>{children}</Places.Provider>;
}

/**
 * Quieter than a link that leaves the app, and told apart from it by its underline: dotted where
 * that one is solid, until it is pointed at.
 */
export const placeLinkClass =
  "rounded-2 text-ink underline decoration-dotted decoration-[1.5px] decoration-icon-soft underline-offset-[3px] outline-none transition-[text-decoration-color] duration-(--dur-hover) focus-ring hover:decoration-solid hover:decoration-current";

/** A place that isn't there any more: its words, muted, with no underline to promise a jump. */
const goneClass = "rounded-2 text-muted outline-none focus-ring";

/**
 * A link to a page or board, in a line of the agent's: it moves the canvas there. One to a place
 * that isn't in the design any more reads as muted text that says so when pointed at; one to
 * another design opens that design. `external` is what it is without a design to follow it in.
 */
export function PlaceLink({
  address,
  href,
  external,
  children,
}: {
  address: CanvasAddress;
  href: string;
  external: ReactNode;
  children: ReactNode;
}) {
  const places = useContext(Places);
  if (!places) return <>{external}</>;
  const here = address.canvasId === places.canvasId;
  const named = address.artboard ? "board" : address.page ? "page" : null;
  if (here && named && places.has(address) === false) {
    return (
      <Tip label={`This ${named} isn't in the design any more`} side="top">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the reason too */}
        <span tabIndex={0} data-place="gone" className={goneClass}>
          {children}
        </span>
      </Tip>
    );
  }
  const open = (e: MouseEvent) => {
    e.preventDefault();
    places.open(address);
  };
  return (
    <a
      href={href}
      onClick={open}
      data-place={here ? (named ?? "canvas") : "other-canvas"}
      aria-description={here ? "Shows it on the canvas" : "Opens that design"}
      className={placeLinkClass}
    >
      {children}
    </a>
  );
}
