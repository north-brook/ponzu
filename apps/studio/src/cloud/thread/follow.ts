/*
 * Following the thread: while the person is at its foot the rail keeps the newest line in view
 * as it grows; once they scroll up to read, it stays where they are and counts what arrives,
 * for the "new" pill that takes them back.
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How close to the foot still counts as at it: a trackpad's last flick rarely lands on zero. */
export const FOOT_SLACK = 24;

export function atFoot(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.clientHeight - m.scrollTop <= FOOT_SLACK;
}

export interface Follow {
  following: boolean;
  /** Items that arrived since the person stopped following. */
  unseen: number;
}

export const FOLLOWING: Follow = { following: true, unseen: 0 };

export type FollowEvent =
  /** The person scrolled. The rail's own scrolls to the foot are not events. */
  | { type: "scrolled"; metrics: ScrollMetrics }
  /** New items at the foot. `mine` is the viewer's own message. */
  | { type: "arrived"; count: number; mine: boolean }
  /** The person asked to go to the foot: the "new" pill, or opening the rail. */
  | { type: "jumped" };

export function follow(state: Follow, event: FollowEvent): Follow {
  switch (event.type) {
    case "scrolled":
      if (atFoot(event.metrics)) return FOLLOWING;
      return state.following ? { following: false, unseen: 0 } : state;
    case "arrived":
      // Sending a message is looking at the foot: what you said, and what answers it.
      if (event.mine || state.following) return FOLLOWING;
      return { following: false, unseen: state.unseen + event.count };
    case "jumped":
      return FOLLOWING;
  }
}
