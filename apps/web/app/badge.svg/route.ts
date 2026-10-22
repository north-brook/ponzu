import type { NextRequest } from "next/server";
import { badgeLabel, badgeSvg } from "../gh/badge";

/** ponzu.design/badge.svg?label=Kettle: the README badge. See app/gh/badge.ts. */
export function GET(request: NextRequest) {
  const label = badgeLabel(request.nextUrl.searchParams.get("label"));
  return new Response(badgeSvg(label), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // GitHub's image proxy (camo) honours this, so a README picks up a new badge within a day.
      "cache-control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
