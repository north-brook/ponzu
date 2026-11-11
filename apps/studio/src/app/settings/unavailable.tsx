import { QuietButton } from "../../cloud/settings/parts.tsx";

/** A section whose answer didn't come: said plainly, with a way to ask again. */
export function SectionUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-12 items-center gap-3">
      <p className="m-0 flex-1 text-13 text-muted">
        Ponzu couldn't load this just now. Check your connection.
      </p>
      <QuietButton onClick={onRetry}>Try again</QuietButton>
    </div>
  );
}
