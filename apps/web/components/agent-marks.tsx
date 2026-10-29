import Image from "next/image";
import type { ReactNode } from "react";

/**
 * Marks for the agents Ponzu works with, at tile size. Vector marks follow the color scheme;
 * T3 Code, Conductor and Grok Bot are their app icons. Cursor and Grok are the marks T3 Code ships;
 * Gemini is from LobeHub's icon set; Claude and OpenAI match @ponzu/react's `AgentMark`.
 */
export type Agent =
  | "claude"
  | "codex"
  | "cursor"
  | "gemini"
  | "grok"
  | "conductor"
  | "t3"
  | "grok-bot";

export const AGENTS: { id: Agent; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "gemini", name: "Gemini" },
  { id: "grok", name: "Grok" },
  { id: "conductor", name: "Conductor" },
  { id: "t3", name: "T3 Code" },
  { id: "grok-bot", name: "Grok Bot" },
];

/** Pixels, or any CSS length, so a mark can grow with its tile. */
type Size = number | string;

export function AgentMark({ agent, size = 24 }: { agent: Agent; size?: Size }) {
  switch (agent) {
    case "t3":
      return <AppIcon src="/agents/t3.png" size={size} />;
    case "grok-bot":
      return <AppIcon src="/agents/grok-bot.png" size={size} />;
    case "claude":
      return (
        <Mark viewBox="0 0 24 24" size={size} className="fill-[#d97757]">
          <path d="m4.7 15.96 4.72-2.65.08-.23-.08-.13h-.23l-.79-.05-2.7-.07-2.34-.1-2.27-.12-.57-.12L0 11.79l.06-.35.48-.32.69.06 1.52.1 2.28.16 1.65.1 2.45.25h.39l.05-.16-.13-.1-.1-.1-2.36-1.6-2.55-1.69-1.34-.97-.72-.5-.37-.46-.16-1.01.66-.73.88.06.22.06.9.69 1.91 1.48 2.5 1.84.36.3.15-.1.02-.07-.17-.27-1.36-2.46-1.45-2.5-.65-1.04-.17-.62a3 3 0 0 1-.1-.74l.75-1.02.42-.13 1 .13.42.37.62 1.42 1 2.24 1.56 3.04.46.9.24.83.09.25h.16v-.15l.13-1.71.24-2.1.23-2.7.08-.76.37-.91.75-.49.58.28.48.69-.07.44-.28 1.85-.56 2.9-.36 1.95h.21l.24-.24.98-1.3 1.65-2.07.73-.82.85-.9.55-.43h1.03l.76 1.13-.34 1.17-1.06 1.35-.88 1.14-1.27 1.7-.79 1.36.07.11.19-.02 2.86-.61 1.55-.28 1.84-.32.83.39.09.4-.33.81-1.97.49-2.31.46-3.44.81-.04.03.05.06 1.55.15.66.04h1.62l3.02.22.79.52.47.64-.08.49-1.21.62-1.64-.39-3.82-.91-1.31-.33h-.18v.11l1.09 1.07 2 1.81 2.51 2.33.13.58-.32.45-.34-.05-2.2-1.66-.85-.75-1.93-1.62h-.13v.17l.44.65 2.34 3.52.12 1.08-.17.35-.61.21-.67-.12-1.37-1.92-1.41-2.17-1.14-1.94-.14.08-.67 7.26-.32.37-.72.28-.6-.46-.32-.74.32-1.46.38-1.9.31-1.5.28-1.88.17-.62-.01-.04-.14.02-1.42 1.95-2.16 2.92-1.71 1.83-.41.16-.71-.37.07-.66.4-.58 2.36-3 1.42-1.86.92-1.08-.01-.15h-.05l-6.28 4.08-1.12.14-.48-.45.06-.74.23-.24 1.89-1.3Z" />
        </Mark>
      );
    case "codex":
      return (
        <Mark viewBox="0 0 24 24" size={size} className="fill-current">
          <path d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .75 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.99 5.99 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06l-4.83 2.79a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87Zm16.6 3.86-5.83-3.39 2.01-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.66Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.39.68Zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.6-1.5Z" />
        </Mark>
      );
    case "cursor":
      return (
        <Mark
          viewBox="0 0 466.73 532.09"
          size={size}
          className="fill-[#26251E] dark:fill-[#EDECEC]"
        >
          <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
        </Mark>
      );
    case "grok":
      return (
        <Mark viewBox="0 0 24 24" size={size} className="fill-[#0F0F0F] dark:fill-[#F5F5F5]">
          <path d="M9.26905 15.284L17.2479 9.36086C17.6391 9.07047 18.1981 9.18374 18.3845 9.63478C19.3655 12.0135 18.9272 14.8721 16.9755 16.8349C15.0238 18.7976 12.3082 19.228 9.8261 18.2477L7.1146 19.5102C11.0037 22.1834 15.7263 21.5223 18.6774 18.5525C21.0182 16.1985 21.7432 12.9897 21.0653 10.0961L21.0714 10.1023C20.0884 5.85143 21.3131 4.15233 23.8218 0.677913C23.8812 0.595532 23.9406 0.513151 24 0.428711L20.6987 3.74866V3.73836L9.267 15.2861" />
          <path d="M7.62249 16.7237C4.83113 14.0422 5.3124 9.89222 7.69417 7.49905C9.45541 5.72786 12.341 5.00497 14.86 6.06768L17.5653 4.81138C17.0779 4.45714 16.4533 4.07613 15.7365 3.80839C12.4966 2.46764 8.6178 3.13492 5.98413 5.78141C3.45081 8.32904 2.65415 12.2463 4.02219 15.5889C5.04412 18.0871 3.36889 19.8541 1.68137 21.6377C1.08337 22.2699 0.483318 22.9022 0 23.5716L7.62045 16.7257" />
        </Mark>
      );
    case "conductor":
      return <AppIcon src="/agents/conductor.png" size={size} />;
    case "gemini":
      return (
        <Mark viewBox="0 0 24 24" size={size}>
          <defs>
            <linearGradient
              id="gemini-a"
              gradientUnits="userSpaceOnUse"
              x1="7"
              x2="11"
              y1="15.5"
              y2="12"
            >
              <stop stopColor="#08B962" />
              <stop offset="1" stopColor="#08B962" stopOpacity="0" />
            </linearGradient>
            <linearGradient
              id="gemini-b"
              gradientUnits="userSpaceOnUse"
              x1="8"
              x2="11.5"
              y1="5.5"
              y2="11"
            >
              <stop stopColor="#F94543" />
              <stop offset="1" stopColor="#F94543" stopOpacity="0" />
            </linearGradient>
            <linearGradient
              id="gemini-c"
              gradientUnits="userSpaceOnUse"
              x1="3.5"
              x2="17.5"
              y1="13.5"
              y2="12"
            >
              <stop stopColor="#FABC12" />
              <stop offset=".46" stopColor="#FABC12" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path fill="#3186FF" d={GEMINI} />
          <path fill="url(#gemini-a)" d={GEMINI} />
          <path fill="url(#gemini-b)" d={GEMINI} />
          <path fill="url(#gemini-c)" d={GEMINI} />
        </Mark>
      );
  }
}

const GEMINI =
  "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";

function Mark({
  viewBox,
  size,
  className,
  children,
}: {
  viewBox: string;
  size: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox={viewBox}
      style={{ width: size, height: size }}
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function AppIcon({ src, size }: { src: string; size: Size }) {
  const icon = typeof size === "number" ? size * 1.3 : `calc(${size} * 1.3)`;
  return (
    <Image
      src={src}
      alt=""
      width={256}
      height={256}
      style={{ width: icon, height: icon }}
      className="object-contain"
    />
  );
}
