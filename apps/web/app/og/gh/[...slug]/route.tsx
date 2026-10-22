import { ImageResponse } from "next/og";
import { loadDesign } from "../../../gh/github";
import { OG_SIZE, OgCard, ogFonts } from "../../../gh/og";
import { parseTarget } from "../../../gh/target";

/*
 * /og/gh/<owner>/<repo>[@ref]/<path>.design: the share card for a design in the viewer
 * (gh/og.tsx). The viewer's metadata links it with the commit it read as `?v=`, so a new commit
 * is a new image to everything that caches one, and each can be kept a day.
 */
export async function GET(request: Request, ctx: RouteContext<"/og/gh/[...slug]">) {
  const target = parseTarget((await ctx.params).slug);
  if (target?.kind !== "design") return new Response("Not a design", { status: 404 });
  const design = await loadDesign(target.owner, target.repo, target.ref ?? "", target.path).catch(
    () => null,
  );
  // Without the design, the site's own card.
  if (!design) return Response.redirect(new URL("/opengraph-image.jpg", request.url), 302);
  return new ImageResponse(<OgCard design={design} />, {
    ...OG_SIZE,
    fonts: await ogFonts(),
    headers: {
      "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
}
