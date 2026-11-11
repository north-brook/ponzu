import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import type { PonzuDesktop, UpdateState } from "@ponzu/desktop/bridge";
import { useEffect, useState } from "react";
import { Button } from "../cloud/ui/button.tsx";
import { Icon } from "../cloud/ui/icon.tsx";
import { Slice } from "../cloud/ui/marks.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../cloud/ui/popover.tsx";

type Updater = PonzuDesktop["update"];

/** The shell's update state, kept current; null until it answers, or with no updater at all. */
export function useUpdate(updater: Updater | null): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!updater) return;
    let live = true;
    const off = updater.onState((next) => live && setState(next));
    void updater.state().then((first) => live && setState((now) => now ?? first));
    return () => {
      live = false;
      off();
    };
  }, [updater]);
  return state;
}

/**
 * A yuzu circle at the chrome's left, past the sidebar toggle, once a newer Ponzu has downloaded. Its popover holds the
 * release notes, which are what's new: nothing shows them again after the restart.
 */
export function UpdateMark({ updater }: { updater: Updater | null }) {
  const state = useUpdate(updater);
  const [open, setOpen] = useState(false);
  if (!updater || !state?.ready) return null;
  const { version, notes } = state.ready;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            state.installing ? `Restarting into Ponzu ${version}` : `Ponzu ${version} is ready`
          }
          className="app-no-drag ml-2 grid size-[18px] shrink-0 cursor-default place-items-center rounded-pill bg-yuzu text-yuzu-ink outline-none transition-[filter] duration-(--dur-hover) focus-ring hover:brightness-[1.04]"
        >
          <Icon icon={ArrowUp02Icon} size={12} stroke={2.6} />
        </button>
      </PopoverTrigger>
      <PopoverContent width={320} side="bottom" align="start" sideOffset={10} className="p-4">
        <UpdateNotes
          version={version}
          notes={notes}
          installing={state.installing}
          onRestart={() => updater.install()}
          onLater={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The popover's body, apart for tests: what's new, then Later and Restart. */
export function UpdateNotes({
  version,
  notes,
  installing,
  onRestart,
  onLater,
}: {
  version: string;
  notes: string[];
  installing: boolean;
  onRestart: () => void;
  onLater: () => void;
}) {
  return (
    <div className="flex flex-col">
      <h2 className="m-0 font-semibold text-14">Ponzu {version}</h2>
      {notes.length ? (
        <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-4 text-13 text-muted leading-[1.45]">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mt-1.5 text-13 text-muted">Fixes and improvements.</p>
      )}
      <p className="m-0 mt-3 text-12 text-faint">
        Restarting takes a moment. Your designs and agents carry on in the cloud.
      </p>
      <div className="mt-3.5 flex justify-end gap-1.5">
        <Button variant="quiet" className="px-3" onClick={onLater} disabled={installing}>
          Later
        </Button>
        <Button variant="action" className="px-3" onClick={onRestart} disabled={installing}>
          {installing ? "Restarting…" : "Restart"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The API won't talk to this build any more (426): nothing else will work, so the window is
 * this. It looks for the update at once, and restarts into it when asked.
 */
export function UpdateRequired({ updater }: { updater: Updater | null }) {
  const state = useUpdate(updater);
  useEffect(() => {
    updater?.check();
  }, [updater]);
  const ready = state?.ready ?? null;
  const canUpdate = Boolean(updater && state?.canUpdate);
  return (
    <div data-screen="update" className="absolute inset-0 flex flex-col items-center pt-[230px]">
      <Slice size={72} className="text-ink" />
      <h1 className="m-0 mt-11 font-display font-semibold text-[28px] tracking-[-0.02em]">
        Ponzu needs an update
      </h1>
      <p className="m-0 mt-3.5 max-w-[420px] text-center text-[15px] text-muted leading-[1.55]">
        {!canUpdate
          ? "This copy of Ponzu is too old to reach your designs. Download the newest one from ponzu.design."
          : ready
            ? `Ponzu ${ready.version} is ready. Restart to keep working; everything you made is waiting.`
            : "This version is too old to reach your designs. The new one is downloading."}
      </p>
      {canUpdate ? (
        <Button
          variant="action"
          className="mt-7 h-9 gap-2 rounded-8 px-[18px] text-13"
          disabled={!ready || state?.installing}
          onClick={() => updater?.install()}
        >
          {ready ? (state?.installing ? "Restarting…" : "Restart to update") : "Downloading…"}
          {ready ? null : <Slice size={14} turning className="text-dry" />}
        </Button>
      ) : null}
    </div>
  );
}
