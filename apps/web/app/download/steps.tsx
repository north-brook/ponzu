import Image from "next/image";
import type { ReactNode } from "react";

/*
 * The three steps between the download and the first design, drawn rather
 * than screenshotted: two Finder windows and a terminal on the stage the home
 * page sets its screenshot on, built from the real macOS icons in
 * /public/download. Step two's title carries the disk image's own badged
 * icon (apps/desktop/build/installer-icon.png), so the page shows what Finder
 * will.
 */

/** A macOS icon at its drawn size. Decorative: the caption carries the meaning. */
function Glyph({ size, src }: { size: number; src: string }) {
  return (
    <Image alt="" className="shrink-0" draggable={false} height={size} src={src} width={size} />
  );
}

const POINTER = "M1.4 1.2 1.4 17.6 5.7 13.7 8.4 19.9 11.1 18.7 8.4 12.6 13.6 12.5Z";

/** The system pointer, over the row it selected. */
function Pointer({ className }: { className?: string }) {
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
function Window({ dark, children }: { dark?: boolean; children: ReactNode }) {
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

/** A Finder row. A selected row takes the yellow accent macOS offers. */
function Row({
  icon,
  name,
  selected,
  children,
}: {
  icon: ReactNode;
  name: string;
  selected?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`relative flex h-10 items-center gap-2.5 px-3.5 ${selected ? "bg-m2 text-[#0e0e0e]" : "text-muted"}`}
    >
      {icon}
      <span className="truncate text-sm/5">{name}</span>
      {children}
    </div>
  );
}

/** Step one: the disk image, already selected, in Downloads. */
function Downloads({ installer }: { installer: string }) {
  return (
    <Window>
      <Title icon={<Glyph size={24} src="/download/downloads-folder.webp" />} name="Downloads" />
      <Row icon={<Glyph size={24} src="/download/disk-image.webp" />} name={installer} selected>
        <Pointer className="absolute top-6 left-[64%] text-ink" />
      </Row>
      <Row icon={<Glyph size={24} src="/download/document.webp" />} name="fernwood brief.pdf" />
      <Row icon={<Glyph size={24} src="/download/document.webp" />} name="hero moodboard.png" />
    </Window>
  );
}

/** Step two: the opened disk image, the app in hand over Applications. */
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

/** Step three: the agent pointed at the canvas the app is serving. */
function Terminal({ url }: { url: string }) {
  return (
    <Window dark>
      <div className="flex h-10 items-center gap-2 border-b border-white/10 px-3.5">
        <i className="size-3 rounded-full bg-white/15" />
        <i className="size-3 rounded-full bg-white/15" />
        <i className="size-3 rounded-full bg-white/15" />
      </div>
      <pre className="m-0 h-[132px] px-4 py-3.5 font-mono text-xs/5 whitespace-pre-wrap text-code-ink">
        <span className="text-white/45">$ </span>claude mcp add \{"\n"}
        {"    "}--transport http \{"\n"}
        {"    "}ponzu {url}
        {"\n\n"}
        <span className="text-white/45">$ </span>claude
        <i className="ml-1 inline-block h-3.5 w-[7px] translate-y-0.5 bg-m1" />
      </pre>
    </Window>
  );
}

/** The noun the step acts on, lifted out of the caption. */
function Key({ children }: { children: ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

function Step({
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
      <div className="flex h-[262px] w-full items-center justify-center overflow-hidden rounded-3xl bg-stage px-[22px] max-[720px]:h-60 max-[720px]:rounded-2xl">
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

/** The three steps, side by side on the desk and stacked on the phone. */
export function Steps({ installer, url }: { installer: string; url: string }) {
  return (
    <ol className="m-0 grid w-full max-w-[1200px] list-none grid-cols-3 gap-6 p-0 max-[1000px]:grid-cols-1 max-[1000px]:gap-10">
      <Step
        caption={
          <>
            Open <Key>{installer}</Key> from your Downloads folder.
          </>
        }
        index={1}
      >
        <Downloads installer={installer} />
      </Step>
      <Step
        caption={
          <>
            Drag <Key>Ponzu</Key> into your Applications folder, then open it.
          </>
        }
        index={2}
      >
        <Installer />
      </Step>
      <Step
        caption={
          <>
            Connect your agent to <Key>{url}</Key> and ask for a design.
          </>
        }
        index={3}
      >
        <Terminal url={url} />
      </Step>
    </ol>
  );
}
