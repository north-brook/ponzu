import type { ReactNode } from "react";
import { Slice } from "@/components/icons";
import { Key, Pointer, Step, Window } from "./steps";

/*
 * The Windows and Linux install steps, drawn like the Mac's (steps.tsx) on the same stage: the
 * download, the install, and an agent asked for a design. Neither OS has icons we can ship, so the
 * app is the slice on its ink tile and the rest is drawn.
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

/** A Windows window's title bar: the name, then minimise and close. */
function WinTitle({ name, dark }: { name: string; dark?: boolean }) {
  return (
    <div
      className={`flex h-10 items-center justify-between border-b px-3.5 text-[13px] ${dark ? "border-white/10 text-white/60" : "border-well-rule text-muted"}`}
    >
      {name}
      <span aria-hidden="true" className="flex gap-4 opacity-70">
        <span>–</span>
        <span>✕</span>
      </span>
    </div>
  );
}

/** A file in a list, the first one selected. */
function FileRow({
  icon,
  name,
  action,
  selected,
  children,
}: {
  icon: ReactNode;
  name: string;
  action?: string;
  selected?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`relative flex h-12 items-center gap-2.5 px-3.5 ${selected ? "bg-m2 text-[#111110]" : "text-muted"}`}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm/5 font-medium">{name}</span>
        {action ? <span className="text-xs/4 underline opacity-70">{action}</span> : null}
      </span>
      {children}
    </div>
  );
}

function Doc() {
  return <span className="size-6 shrink-0 rounded-[5px] bg-chip" />;
}

/** The agent asked for a design, in a terminal of the OS's own. */
function Terminal({ title, prompt }: { title: string; prompt: string }) {
  return (
    <Window dark>
      <WinTitle name={title} dark />
      <pre className="m-0 h-[132px] px-4 py-3.5 font-mono text-xs/5 whitespace-pre-wrap text-code-ink">
        <span className="text-white/45">{prompt}</span>claude
        {"\n\n"}
        <span className="text-white/45">&gt; </span>Design a landing page for my app in Ponzu.
        <i className="ml-1 inline-block h-3.5 w-[7px] translate-y-0.5 bg-m1" />
      </pre>
    </Window>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="m-0 grid w-full max-w-[1200px] list-none grid-cols-3 gap-6 p-0 max-[1000px]:grid-cols-1 max-[1000px]:gap-10">
      {children}
    </ol>
  );
}

/** Windows: the browser's downloads, the installer, PowerShell. */
export function WindowsSteps({ installer }: { installer: string }) {
  return (
    <Steps>
      <Step
        index={1}
        caption={
          <>
            Open <Key>{installer}</Key> from your downloads.
          </>
        }
      >
        <Window>
          <WinTitle name="Downloads" />
          <FileRow icon={<AppTile size={26} />} name={installer} action="Open file" selected>
            <Pointer className="absolute top-7 left-[52%] text-ink" />
          </FileRow>
          <FileRow icon={<Doc />} name="fernwood brief.pdf" />
        </Window>
      </Step>
      <Step
        index={2}
        caption={
          <>
            If Windows says it protected your PC, choose <Key>More info</Key>, then{" "}
            <Key>Run anyway</Key>. <Key>Ponzu</Key> installs just for you and opens.
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
      <Step index={3} caption="Ask your agent for a design.">
        <Terminal title="PowerShell" prompt="PS C:\code> " />
      </Step>
    </Steps>
  );
}

/** Linux: let the AppImage run, open it, ask an agent. */
export function LinuxSteps({ installer }: { installer: string }) {
  return (
    <Steps>
      <Step
        index={1}
        caption={
          <>
            In <Key>{installer}</Key>'s properties, allow it to run as a program.
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
      <Step
        index={2}
        caption={
          <>
            Open it. <Key>Ponzu</Key> adds itself to your apps and updates itself.
          </>
        }
      >
        <Window>
          <WinTitle name="Apps" />
          <div className="grid h-[132px] grid-cols-3 place-items-center px-4">
            <span className="flex flex-col items-center gap-1.5 text-xs text-ink">
              <AppTile size={44} />
              Ponzu
            </span>
            <span className="size-11 rounded-[10px] bg-chip" />
            <span className="size-11 rounded-[10px] bg-chip" />
          </div>
        </Window>
      </Step>
      <Step index={3} caption="Ask your agent for a design.">
        <Terminal title="Terminal" prompt="~/code$ " />
      </Step>
    </Steps>
  );
}
