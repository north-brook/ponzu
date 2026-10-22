"use client";

import { useParams } from "next/navigation";
import { ViewerErrorPage } from "../chrome";
import { DIGEST, parseTarget } from "../target";

/**
 * GitHub rate-limited us or didn't answer. The page throws these rather than render them, so a
 * passing failure is never kept as the page. The error's digest says which (github.ts); anything
 * else reads as GitHub being unavailable.
 */
export default function ViewerFailure({ error, retry }: { error: unknown; retry: () => void }) {
  const slug = useParams<{ slug: string[] }>().slug;
  const target = slug ? parseTarget(slug) : null;
  const digest = (error as { digest?: unknown } | null)?.digest;
  const kind = digest === `${DIGEST}rate-limited` ? "rate-limited" : "unavailable";
  return (
    <ViewerErrorPage
      kind={kind}
      owner={target?.owner}
      repo={target?.repo}
      path={
        target ? (target.kind === "design" ? target.path : target.prefix) || undefined : undefined
      }
      retry={retry}
    />
  );
}
