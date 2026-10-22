"use client";

import { useParams } from "next/navigation";
import { ViewerErrorPage } from "../chrome";
import { parseTarget } from "../target";

/**
 * GitHub rate-limited us or didn't answer. The page throws these rather than
 * render them, so a passing failure is never kept as the page. Production hides
 * a server error's message, so the two read as one.
 */
export default function ViewerFailure({ retry }: { error: unknown; retry: () => void }) {
  const slug = useParams<{ slug: string[] }>().slug;
  const target = slug ? parseTarget(slug) : null;
  return (
    <ViewerErrorPage
      kind="unavailable"
      owner={target?.owner}
      repo={target?.repo}
      path={
        target ? (target.kind === "design" ? target.path : target.prefix) || undefined : undefined
      }
      retry={retry}
    />
  );
}
