"use client";

import { AgentMark, Icon } from "@ponzu/react";
import "@ponzu/react/styles.css";
import "./demo.css";

/** Ponzu's class strings for pins and cards (Canvas.tsx, Comments.tsx), so they match exactly. */
const PIN =
  "pz:grid pz:size-6 pz:shrink-0 pz:place-items-center pz:rounded-full pz:bg-comment pz:font-semibold pz:text-[11px] pz:text-comment-foreground pz:tabular-nums pz:shadow-[0_1px_3px_rgba(0,0,0,0.25)]";
const CARD = "w-full max-w-[380px] pz:overflow-hidden pz:rounded-xl pz:bg-card pz:shadow-pop";
const TEXT = "pz:whitespace-pre-wrap pz:text-[13.5px] pz:leading-[1.55]";
const GHOST =
  "pz:inline-flex pz:size-[26px] pz:items-center pz:justify-center pz:rounded-[7px] pz:text-muted-foreground";

/**
 * The "Steer with comments" tile: a question on the canvas and Claude's answer, in Ponzu 1.4's
 * comment card. Claude replies here because you asked for its pick; a change it simply makes gets
 * resolved without a reply.
 */
export function CommentThread() {
  return (
    <div aria-hidden="true" className="dm pz-root dm-thread-tile">
      <span className={PIN}>2</span>
      <div className={`relative ${CARD}`}>
        <div className="pz:absolute pz:top-1.5 pz:right-1.5 pz:flex pz:gap-0.5">
          <span className={GHOST}>
            <Icon name="check" size={15} />
          </span>
          <span className={GHOST}>
            <Icon name="close" size={15} />
          </span>
        </div>
        <div className="pz:flex pz:flex-col pz:gap-3.5 pz:pt-3 pz:pr-16 pz:pb-3.5 pz:pl-3.5">
          <div className={TEXT}>Sunroom or Night Garden for the launch? Your call.</div>
          <div className="pz:flex pz:flex-col pz:gap-1">
            <div className="pz:flex pz:items-center pz:gap-1.5">
              <AgentMark client="claude" size={18} />
              <span className="pz:font-medium">Claude</span>
              <span className="pz:text-[11.5px] pz:text-muted-foreground">now</span>
            </div>
            <div className={TEXT}>
              Sunroom. It reads as a shop at a glance, and the warm light suits an autumn launch.
              Night Garden is better kept for the late-hours event page.
            </div>
          </div>
        </div>
        <div className="pz:flex pz:items-end pz:gap-2 pz:border-t pz:py-2 pz:pr-2 pz:pl-3.5">
          <span className="pz:min-h-7 pz:flex-1 pz:py-1 pz:text-[13.5px] pz:leading-[1.55]">
            Thanks, going with Sunroom.
            <span className="dm-text-caret" />
          </span>
          <span className="pz:inline-flex pz:size-7 pz:shrink-0 pz:items-center pz:justify-center pz:rounded-lg pz:bg-primary pz:text-primary-foreground">
            <Icon name="send" size={14} />
          </span>
        </div>
      </div>
    </div>
  );
}
