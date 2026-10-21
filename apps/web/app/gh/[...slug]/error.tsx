"use client";

import { ViewerErrorPage } from "../chrome";

/**
 * GitHub rate-limited us or didn't answer. The page throws these rather than
 * render them, so a passing failure is never kept as the page. Production hides
 * a server error's message, so the two read as one.
 */
export default function ViewerFailure({ retry }: { error: unknown; retry: () => void }) {
  return <ViewerErrorPage kind="unavailable" retry={retry} />;
}
