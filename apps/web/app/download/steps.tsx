import Image from "next/image";
import type { ReactNode } from "react";
import { GitHub, Slice } from "@/components/icons";

/*
 * The three steps between the download and the first canvas, drawn rather than screenshotted, on
 * the stage the home page sets its screenshot on: the install (a Finder window built from the real
 * macOS icons in /public/download, its title carrying the disk image's own badged icon from
 * apps/desktop/build/installer-icon.png), then Ponzu's own sign-in and its "Make something in"
 * page. The last two are drawn after the app's screens (apps/studio/src/cloud/setup/sign-in.tsx
 * and create/create-page.tsx) and shared with the Windows and Linux steps (other-steps.tsx). The
 * repo in the drawing is made up.
 */

/** A macOS icon at its drawn size. Decorative: the caption carries the meaning. */
export function Glyph({ size, src }: { size: number; src: string }) {
  return (
    <Image alt="" className="shrink-0" draggable={false} height={size} src={src} width={size} />
  );
}

const POINTER = "M1.4 1.2 1.4 17.6 5.7 13.7 8.4 19.9 11.1 18.7 8.4 12.6 13.6 12.5Z";

/** The system pointer, over the row it selected. */
export function Pointer({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={22}
      viewBox="0 0 16 22"
      width={16}
    >
      <path
        d={POINTER}
        fill="currentColor"
        stroke="var(--well)"
        strokeLinejoin="round"
        strokeWidth={1.4}
      />
    </svg>
  );
}

/** What macOS shows while a file is dragged between volumes: the arrow with the copy badge. */
function CopyPointer({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={30}
      viewBox="0 0 26 30"
      width={26}
    >
      <path
        d={POINTER}
        fill="currentColor"
        stroke="var(--well)"
        strokeLinejoin="round"
        strokeWidth={1.4}
      />
      <circle cx={17} cy={21} fill="#34c759" r={6} />
      <path d="M14 21h6M17 18v6" stroke="#fff" strokeLinecap="round" strokeWidth={1.6} />
    </svg>
  );
}

/** The move from one place to the other. */
function Arrow({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={12}
      viewBox="0 0 38 12"
      width={38}
    >
      <path
        d="M1 6h35m-5.4-4.6L36 6l-5.4 4.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </svg>
  );
}

/** A window on the stage: the window's radius and its shadow. */
export function Window({ dark, children }: { dark?: boolean; children: ReactNode }) {
  return (
    <div
      className={`w-full max-w-[300px] overflow-hidden rounded-xl text-left shadow-[inset_0_0_0_1px_var(--well-rule),0_24px_56px_var(--stage-shadow),0_2px_8px_var(--stage-shadow)] ${dark ? "bg-code" : "bg-well"}`}
    >
      {children}
    </div>
  );
}

/** A Finder window's title row: the folder's icon and its name. */
function Title({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <div className="flex h-10 items-center gap-2 border-b border-well-rule px-3">
      {icon}
      <span className="text-sm/5 font-semibold text-ink">{name}</span>
    </div>
  );
}

/** The Mac's install: the opened disk image, the app in hand over Applications. */
function Installer() {
  return (
    <Window>
      <Title icon={<Glyph size={24} src="/download/ponzu-installer.png" />} name="Ponzu" />
      <div className="flex h-[132px] items-center justify-center gap-[22px] px-4">
        <div className="relative shrink-0">
          <div className="opacity-85">
            <Glyph size={80} src="/download/ponzu.png" />
          </div>
          <CopyPointer className="absolute top-10 left-[46px] text-ink" />
        </div>
        <Arrow className="shrink-0 text-faint" />
        <div className="flex size-[92px] shrink-0 items-center justify-center rounded-[14px] border border-dashed border-outline">
          <Glyph size={80} src="/download/applications-folder.webp" />
        </div>
      </div>
    </Window>
  );
}

/** A Mac window's title bar: the three lights. */
export function MacBar() {
  return (
    <div className="flex h-10 items-center gap-2 border-b border-well-rule px-3.5">
      <i className="size-3 rounded-full bg-chip shadow-[inset_0_0_0_1px_var(--well-rule)]" />
      <i className="size-3 rounded-full bg-chip shadow-[inset_0_0_0_1px_var(--well-rule)]" />
      <i className="size-3 rounded-full bg-chip shadow-[inset_0_0_0_1px_var(--well-rule)]" />
    </div>
  );
}

/** Ponzu's first screen: the mark, "Sign in to Ponzu" and the one button, about to be pressed. */
function SignIn({ bar }: { bar: ReactNode }) {
  return (
    <Window>
      {bar}
      <div className="flex h-[132px] flex-col items-center justify-center gap-2.5 px-4">
        <Slice size={26} />
        <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-ink">
          Sign in to Ponzu
        </span>
        <span className="relative inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-[7px] text-xs font-semibold text-ground">
          <GitHub />
          Continue with GitHub
          <Pointer className="absolute top-4 left-[70%] text-ink" />
        </span>
      </div>
    </Window>
  );
}

/** Ponzu's create page: a repo picked and the first ask being typed. */
function Describe({ bar }: { bar: ReactNode }) {
  return (
    <Window>
      {bar}
      <div className="flex h-[132px] flex-col items-center justify-center gap-3 px-4">
        <span className="flex flex-col items-center font-display text-[15px]/[19px] font-semibold tracking-[-0.01em] text-ink">
          Make something in
          <span className="text-muted">{DRAWN_REPO}</span>
        </span>
        <span className="flex w-full items-center gap-2 rounded-full bg-chip py-1.5 pr-1.5 pl-3.5 text-xs text-ink shadow-[inset_0_0_0_1px_var(--well-rule)]">
          <span className="flex-1 truncate">
            A pricing page, three takes
            <i className="ml-0.5 inline-block h-3 w-px translate-y-0.5 bg-ink" />
          </span>
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-m1 text-[13px] leading-none text-[#111110]"
          >
            ↑
          </span>
        </span>
      </div>
    </Window>
  );
}

/**
 * The repo the create page in the drawing names: made up, owned by the gallery's fictional person
 * (apps/studio/src/cloud/gallery/fixtures.ts), so no real account appears on the site.
 */
export const DRAWN_REPO = "adapark/kettle";

/** The noun the step acts on, lifted out of the caption. */
export function Key({ children }: { children: ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

export function Step({
  caption,
  index,
  children,
}: {
  caption: ReactNode;
  index: number;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col">
      <div className="flex h-[262px] w-full items-center justify-center stage overflow-hidden rounded-3xl px-[22px] max-[720px]:h-60 max-[720px]:rounded-2xl">
        {children}
      </div>
      <div className="flex gap-3 pt-5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12.5px] leading-none font-medium text-ground">
          {index}
        </span>
        <p className="m-0 pt-px text-base/[22px] text-pretty text-muted">{caption}</p>
      </div>
    </li>
  );
}

/** What the two steps after the install say, the same on every desktop (design §3.3). */
export const AFTER_INSTALL = [
  "Open Ponzu and continue with GitHub.",
  "Install Ponzu on the GitHub account where your repos live, connect Claude, and describe what you want to make.",
] as const;

/** Steps two and three, the same on every desktop once Ponzu is installed. `bar` is the OS's own. */
export function AfterInstall({ bar }: { bar: ReactNode }) {
  return (
    <>
      <Step caption={AFTER_INSTALL[0]} index={2}>
        <SignIn bar={bar} />
      </Step>
      <Step caption={AFTER_INSTALL[1]} index={3}>
        <Describe bar={bar} />
      </Step>
    </>
  );
}

/** The three steps, side by side on the desk and stacked on the phone. */
export function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="m-0 grid w-full max-w-[1200px] list-none grid-cols-3 gap-6 p-0 max-[1000px]:grid-cols-1 max-[1000px]:gap-10">
      {children}
    </ol>
  );
}

/** The Mac: open the disk image and drag Ponzu into Applications, then sign in and describe it. */
export function MacSteps({ installer }: { installer: string }) {
  return (
    <Steps>
      <Step
        caption={
          <>
            Open <Key>{installer}</Key> and drag <Key>Ponzu</Key> into your Applications folder.
          </>
        }
        index={1}
      >
        <Installer />
      </Step>
      <AfterInstall bar={<MacBar />} />
    </Steps>
  );
}
