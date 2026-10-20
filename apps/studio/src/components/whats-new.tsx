import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface WhatsNewNotes {
  version: string;
  notes: string[];
}

/**
 * After the desktop app restarts into an update, once: the release notes of
 * every version since the one whose notes it last showed. The desktop app
 * decides what's pending (apps/desktop/src/whats-new.ts); closing the dialog
 * marks it seen. The browser studio has no updates and shows nothing. See
 * docs/release-notes.md.
 */
export function WhatsNew() {
  const [pending, setPending] = useState<WhatsNewNotes | null>(null);
  useEffect(() => {
    window.ponzuDesktop
      ?.whatsNew?.()
      .then(setPending)
      .catch(() => {});
  }, []);
  const dismiss = () => {
    window.ponzuDesktop?.whatsNewSeen?.();
    setPending(null);
  };
  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What's new</DialogTitle>
          <DialogDescription>Ponzu {pending?.version}</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[min(420px,60vh)] list-disc flex-col gap-1.5 overflow-y-auto pl-5 leading-5 marker:text-muted-foreground">
          {pending?.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={dismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
