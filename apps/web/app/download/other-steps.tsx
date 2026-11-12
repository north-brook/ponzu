import { Slice } from "@/components/icons";
import { AfterInstall, Key, Pointer, Step, Steps, Window } from "./steps";

/*
 * The Windows and Linux install steps, drawn like the Mac's (steps.tsx) on the same stage: the
 * install, then the sign-in and the first ask, which every desktop shares. Neither OS has icons we
 * can ship, so the app is the slice on its ink tile and the rest is drawn.
 */

/** The app's icon: the yuzu slice on an ink tile. */
function AppTile({ size }: { size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center bg-[#111110]"
      style={{ width: size, height: size, borderRadius: size * 0.24 }}
    >
      <Slice size={size * 0.6} className="[--slice:#ffc81e]" />
    </span>
  );
}

/** A Windows or Linux window's title bar: the name, then minimise and close. */
function WinTitle({ name }: { name: string }) {
  return (
    <div className="flex h-10 items-center justify-between border-b border-well-rule px-3.5 text-[13px] text-muted">
      {name}
      <span aria-hidden="true" className="flex gap-4 opacity-70">
        <span>–</span>
        <span>✕</span>
      </span>
    </div>
  );
}

/** Windows: run the installer (past SmartScreen), then sign in and describe it. */
export function WindowsSteps({ installer }: { installer: string }) {
  return (
    <Steps>
      <Step
        index={1}
        caption={
          <>
            Open <Key>{installer}</Key> from your downloads. If Windows says it protected your PC,
            choose <Key>More info</Key>, then <Key>Run anyway</Key>.
          </>
        }
      >
        <Window>
          <WinTitle name="Ponzu Setup" />
          <div className="flex h-[132px] flex-col items-center justify-center gap-3.5 px-6">
            <AppTile size={44} />
            <span className="text-sm font-semibold text-ink">Installing Ponzu…</span>
            <span className="h-1 w-full overflow-hidden rounded-full bg-chip">
              <span className="block h-full w-2/3 bg-m1" />
            </span>
          </div>
        </Window>
      </Step>
      <AfterInstall bar={<WinTitle name="Ponzu" />} />
    </Steps>
  );
}

/** Linux: let the AppImage run and open it, then sign in and describe it. */
export function LinuxSteps({ installer }: { installer: string }) {
  return (
    <Steps>
      <Step
        index={1}
        caption={
          <>
            In <Key>{installer}</Key>'s properties, allow it to run as a program, then open it.
          </>
        }
      >
        <Window>
          <WinTitle name={`${installer} Properties`} />
          <div className="flex h-[132px] flex-col justify-center gap-3 px-4">
            <span className="flex items-center gap-2.5">
              <AppTile size={30} />
              <span className="truncate text-sm font-medium text-ink">{installer}</span>
            </span>
            <span className="relative flex items-center justify-between rounded-lg bg-m2 px-3 py-2.5 text-sm text-[#111110]">
              Allow executing as a program
              <span className="flex h-5 w-9 items-center rounded-full bg-[#111110] p-0.5">
                <span className="ml-auto size-4 rounded-full bg-m1" />
              </span>
              <Pointer className="absolute top-6 right-3 text-ink" />
            </span>
          </div>
        </Window>
      </Step>
      <AfterInstall bar={<WinTitle name="Ponzu" />} />
    </Steps>
  );
}
