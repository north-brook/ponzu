/*
 * The letter every email is (designs/email.md §4): one centred column on white, the yuzu tile,
 * a title, a paragraph or two, at most one action, a hairline and the footer. Table-based where
 * classic Outlook needs it (React Email's Container), inline styles from tokens, and one style
 * block for what only a style block can say: the dark theme where a mail app honours it, the
 * Outlook apps' own dark attributes, the phone's narrower padding, and the display face.
 */
import type { ReactNode } from "react";
import { Body, Container, Head, Hr, Html, Img, Preview } from "react-email";
import { DISPLAY_FONT_URL, TILE_URL } from "../brand.ts";
import { DARK, FONT, LIGHT, SPACE, TYPE } from "../tokens.ts";
import { words } from "../words.ts";

const px = ([size, line]: readonly [number, number]) => ({
  fontSize: `${size}px`,
  lineHeight: `${line}px`,
});

/** The dark theme's colours (`ink`) and grounds (`ground`), by class. */
const DARK_INK: readonly [string, string][] = [
  ["pz-ink", `color:${DARK.ink}`],
  ["pz-muted", `color:${DARK.muted}`],
  ["pz-faint", `color:${DARK.faint}`],
  ["pz-hairline", `border-color:${DARK.hairline}`],
  ["pz-action", `color:${DARK.actionInk}`],
];
const DARK_GROUND: readonly [string, string][] = [
  ["pz-ground", `background-color:${DARK.ground}`],
  ["pz-track", `background-color:${DARK.hairline}`],
  ["pz-fill", `background-color:${DARK.ink}`],
  ["pz-action", `background-color:${DARK.action}`],
];

const rules = (scope: string, list: readonly [string, string][]) =>
  list.map(([name, decl]) => `${scope}.${name}{${decl} !important}`).join("");

export const STYLE = [
  ":root{color-scheme:light dark;supported-color-schemes:light dark}",
  `body{margin:0;background-color:${LIGHT.ground}}`,
  // The display face, for Apple Mail, iOS Mail and the few others that load one. Declared here
  // rather than with React Email's `Font`, whose `* { font-family }` rule would put every
  // element without an inline family in the display face.
  `@font-face{font-family:'Funnel Display';font-style:normal;font-weight:600;mso-font-alt:'Arial';src:url(${DISPLAY_FONT_URL}) format('woff2')}`,
  `@media (max-width:600px){.pz-column{padding:${SPACE.phoneTop}px ${SPACE.phoneSide}px !important}}`,
  `@media (prefers-color-scheme:dark){${rules("", DARK_INK)}${rules("", DARK_GROUND)}}`,
  // The Outlook apps mark what they darken with these attributes; say what dark should be.
  rules("[data-ogsc] ", DARK_INK),
  rules("[data-ogsb] ", DARK_GROUND),
].join("");

export function Layout({
  subject,
  preview,
  children,
}: {
  subject: string;
  preview: string;
  children: ReactNode;
}) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{subject}</title>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant style sheet. */}
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </Head>
      <Preview useTitleTag={false}>{preview}</Preview>
      {/* React Email's Body copies its style, not its class, onto an inner cell, so the ground
          is drawn by a wrapper that carries both, and the dark rule can reach it. */}
      <Body className="pz-ground" style={{ margin: 0, padding: 0 }}>
        <div className="pz-ground" style={{ backgroundColor: LIGHT.ground, color: LIGHT.ink }}>
          <Container style={{ width: "100%", maxWidth: `${SPACE.columnMax}px` }}>
            <div
              className="pz-column"
              style={{
                padding: `${SPACE.top}px ${SPACE.side}px`,
                fontFamily: FONT.body,
                ...px(TYPE.body),
                color: LIGHT.ink,
              }}
            >
              {children}
            </div>
          </Container>
        </div>
      </Body>
    </Html>
  );
}

/** The yuzu tile, top left. The From name already says Ponzu, so there is no wordmark. */
export function Mark() {
  return (
    <Img
      src={TILE_URL}
      width={SPACE.mark}
      height={SPACE.mark}
      alt="Ponzu"
      style={{ display: "block", border: 0, marginBottom: `${SPACE.afterMark}px` }}
    />
  );
}

/** A muted line above the title (the recap's date). */
export function DateLine({ children }: { children: ReactNode }) {
  return (
    <p className="pz-muted" style={{ margin: "0 0 8px", ...px(TYPE.muted), color: LIGHT.muted }}>
      {children}
    </p>
  );
}

export function Title({ children, large = false }: { children: ReactNode; large?: boolean }) {
  return (
    <h1
      className="pz-ink"
      style={{
        margin: `0 0 ${SPACE.afterTitle}px`,
        fontFamily: FONT.display,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        ...px(large ? TYPE.recapTitle : TYPE.title),
        color: LIGHT.ink,
      }}
    >
      {children}
    </h1>
  );
}

export function Paragraph({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <p
      className={muted ? "pz-muted" : "pz-ink"}
      style={{
        margin: `0 0 ${SPACE.afterParagraph}px`,
        ...px(muted ? TYPE.muted : TYPE.body),
        color: muted ? LIGHT.muted : LIGHT.ink,
      }}
    >
      {children}
    </p>
  );
}

/** Space after the content (a list, the bar), before the action or the hairline. */
export function Gap({ size = SPACE.afterContent }: { size?: number }) {
  return (
    <div
      data-skip-in-text="true"
      style={{ height: `${size}px`, lineHeight: `${size}px`, fontSize: "1px" }}
    >
      &#8202;
    </div>
  );
}

/** A link in the body or the footer: ink (or muted) and underlined, never blue. */
export function TextLink({
  href,
  children,
  muted = false,
}: {
  href: string;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <a
      href={href}
      className={muted ? "pz-muted" : "pz-ink"}
      style={{ color: muted ? LIGHT.muted : LIGHT.ink, textDecoration: "underline" }}
    >
      {children}
    </a>
  );
}

/**
 * The footer: the reason, the one control (a `Stop …` link, or a sentence that says it can't be
 * turned off), the Reply-To line where it applies, and who sends it.
 */
export function Footer({
  reason,
  stop,
  reply = false,
}: {
  reason: string;
  stop?: { href: string; label: string };
  reply?: boolean;
}) {
  const line = { margin: "0 0 6px", ...px(TYPE.footer), color: LIGHT.muted };
  return (
    <>
      <Hr
        data-skip-in-text="true"
        className="pz-hairline"
        style={{
          border: "none",
          borderTop: `1px solid ${LIGHT.hairline}`,
          margin: `${SPACE.afterAction - SPACE.afterParagraph}px 0 ${SPACE.afterHairline}px`,
        }}
      />
      <p className="pz-muted" style={line}>
        {reason}
      </p>
      {stop ? (
        <p className="pz-muted" style={line}>
          <TextLink href={stop.href} muted>
            {stop.label}
          </TextLink>
        </p>
      ) : null}
      {reply ? (
        <p className="pz-muted" style={line}>
          {words.replyLine}
        </p>
      ) : null}
      <p className="pz-muted" style={{ ...line, margin: "12px 0 0" }}>
        {words.entity}
      </p>
    </>
  );
}

export { px };
