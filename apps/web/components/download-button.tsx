"use client";

import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { btn } from "./button";
import { phone } from "./device";
import { Apple, Check, Chevron, DownloadArrow, Linux, PhoneIcon, Terminal, Windows } from "./icons";
import { guide, OSES, type Os, PLATFORMS } from "./platforms";

/** Opens the handoff sheet (components/handoff.tsx), with this desktop picked. */
export function openHandoff(os?: Os) {
  window.dispatchEvent(new CustomEvent("ponzu:handoff", { detail: os }));
}

/** On a phone a Download button hands the link to a computer instead of downloading. */
function handOff(e: MouseEvent, os?: Os) {
  if (!phone()) return false;
  e.preventDefault();
  openHandoff(os);
  return true;
}

export function OsIcon({ os }: { os: Os }) {
  return os === "mac" ? <Apple /> : os === "windows" ? <Windows /> : <Linux />;
}

const sizes = {
  sm: "gap-[7px] py-[9px] pr-4 pl-3.5 text-sm",
  lg: "py-[15px] pr-6 pl-5 text-base",
};

/**
 * A Download button for one desktop: a link to its install steps (or straight to a file). On a phone
 * it opens the handoff sheet with that desktop picked.
 */
export function DownloadButton({
  os,
  href = guide(os),
  size = "lg",
  onClick,
  className = "bg-cta text-cta-ink",
  icon = <OsIcon os={os} />,
  children,
}: {
  os: Os;
  href?: string;
  size?: "sm" | "lg";
  onClick?: () => void;
  className?: string;
  /** Defaults to the desktop's own mark. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <a
      className={`${btn} ${sizes[size]} ${className}`}
      href={href}
      onClick={(e) => {
        if (!handOff(e, os)) onClick?.();
      }}
    >
      {icon}
      {children}
    </a>
  );
}

/**
 * The header's Download: the visitor's desktop, picked before paint (`.os-*` in globals.css), or
 * the index of every download when we can't tell.
 */
export function NavDownload({ className = "" }: { className?: string }) {
  return (
    <>
      {OSES.map((os) => (
        <DownloadButton
          key={os}
          os={os}
          size="sm"
          className={`os-${os} bg-cta text-cta-ink ${className}`}
        >
          Download
        </DownloadButton>
      ))}
      <a
        className={`os-other ${btn} ${sizes.sm} bg-cta text-cta-ink ${className}`}
        href="/download"
      >
        <DownloadArrow />
        Download
      </a>
    </>
  );
}

/**
 * The page's main Download: a split button. Its main half says the visitor's desktop and goes to
 * its install steps; the chevron opens every other way to get Ponzu. On a phone the main half hands
 * off and there's no chevron (the sheet has its own picker). Designed in
 * .context/windows-linux.design (Download button › A).
 */
export function DownloadSplit({ testflight }: { testflight: string | null }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const half = "inline-flex items-center gap-[9px] py-[15px] pr-[18px] pl-5";
  return (
    <div ref={root} className="relative inline-flex">
      <div className="inline-flex items-stretch rounded-full bg-cta text-base font-semibold whitespace-nowrap text-cta-ink transition-[translate] duration-150 ease-out hover:-translate-y-px">
        {OSES.map((os) => (
          <a
            key={os}
            className={`os-${os} ${half}`}
            href={guide(os)}
            onClick={(e) => handOff(e, os)}
          >
            <OsIcon os={os} />
            {PLATFORMS[os].label}
          </a>
        ))}
        {/* No desktop to name: ChromeOS and the like, and Android, whose sheet picks Windows. */}
        <a className={`os-other ${half}`} href="/download" onClick={(e) => handOff(e)}>
          <DownloadArrow />
          Download Ponzu
        </a>
        <span aria-hidden="true" className="desktop-only my-2.5 w-px bg-current opacity-20" />
        <button
          type="button"
          className="desktop-only flex items-center rounded-r-full pr-4 pl-[13px] hover:bg-white/10 aria-expanded:bg-white/10"
          aria-label="Other downloads"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menu}
          onClick={() => setOpen((o) => !o)}
        >
          <Chevron
            className={`size-3 transition-[rotate] duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {open ? (
        <div id={menu} role="menu" className="download-menu">
          {OSES.map((os) => {
            const p = PLATFORMS[os];
            return (
              <a key={os} role="menuitem" className={`download-row os-row-${os}`} href={guide(os)}>
                <span className="download-row-icon">
                  <OsIcon os={os} />
                </span>
                <span className="flex flex-col">
                  <span className="text-[15px] font-semibold text-ink">{p.name}</span>
                  <span className="text-[13px] text-faint">
                    {p.beta ? "Beta · " : ""}
                    {p.needs}
                  </span>
                </span>
              </a>
            );
          })}
          <span aria-hidden="true" className="mx-3 my-1.5 h-px bg-rule" />
          {testflight ? (
            <a role="menuitem" className="download-row" href={testflight}>
              <span className="download-row-icon">
                <PhoneIcon />
              </span>
              <span className="flex flex-col">
                <span className="text-[15px] font-semibold text-ink">iPhone</span>
                <span className="text-[13px] text-faint">
                  Beta · pairs with Ponzu on your computer
                </span>
              </span>
            </a>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="download-row text-left"
            onClick={() => {
              void navigator.clipboard?.writeText("bunx ponzu serve").then(() => setCopied(true));
            }}
          >
            <span className="download-row-icon">
              <Terminal />
            </span>
            <span className="flex flex-col">
              <span className="text-[15px] font-semibold text-ink">Terminal</span>
              {/* Tapping the row copies the command; the line under it says so. */}
              <span className="flex items-center gap-1.5 text-[13px] text-faint" aria-live="polite">
                {copied ? (
                  <>
                    <Check className="size-3 shrink-0 fill-none stroke-current text-ok" />
                    Copied
                  </>
                ) : (
                  <span className="font-mono text-[12.5px]">bunx ponzu serve</span>
                )}
              </span>
            </span>
          </button>
          <span aria-hidden="true" className="mx-3 my-1.5 h-px bg-rule" />
          <a role="menuitem" className="download-all" href="/download">
            All downloads
            <span aria-hidden="true">→</span>
          </a>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Under the Download button on a phone, which hands the download to a computer: the other desktops
 * (each opens the sheet with it picked) and the iPhone beta, which isn't offered on Android.
 */
export function PhonePlatforms({ testflight }: { testflight: string | null }) {
  const link = "inline-flex h-11 items-center gap-1.5 px-1";
  const label = "underline decoration-outline underline-offset-4";
  return (
    <p className="phone-only m-0 -mt-2 flex items-center justify-center gap-1.5 text-sm text-muted">
      {(["windows", "linux"] as const).map((os, i) => (
        <span key={os} className="flex items-center gap-1.5">
          {i ? (
            <span aria-hidden="true" className="text-outline">
              ·
            </span>
          ) : null}
          <button type="button" className={link} onClick={() => openHandoff(os)}>
            <OsIcon os={os} />
            <span className={label}>{PLATFORMS[os].name}</span>
          </button>
        </span>
      ))}
      {testflight ? (
        <span className="ios-only flex items-center gap-1.5">
          <span aria-hidden="true" className="text-outline">
            ·
          </span>
          <a className={link} href={testflight}>
            <PhoneIcon />
            <span className={label}>iPhone beta</span>
            <span aria-hidden="true" className="text-xs text-faint">
              ↗
            </span>
          </a>
        </span>
      ) : null}
    </p>
  );
}
