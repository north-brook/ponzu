/*
 * The site's three families, served from this folder instead of fetched from Google Fonts at
 * build time, so a build never waits on the network: Inter (variable, every weight), Funnel
 * Display 600 and 700 for headlines and the wordmark, and IBM Plex Mono 400 and 500 for
 * commands, file names and code. The files are the ones Google Fonts serves (README.md says
 * which and from where), cut into the same subsets with the same unicode-ranges, so the site
 * draws exactly what next/font/google drew. next/font/local takes no unicode-range per file, so
 * each subset is a call of its own, and every call names its family's real name.
 *
 * Only the Latin subsets are preloaded, as before. The variables the type stacks are built from,
 * and the fallback faces shown until a font arrives, are in fonts.css: next/font/local would
 * name a variable's family after the JavaScript constant, not the family.
 */
import localFont from "next/font/local";
import "./fonts.css";

const interCyrillicExt = localFont({
  src: [{ path: "./inter-cyrillic-ext.woff2", weight: "100 900", style: "normal" }],
  declarations: [
    { prop: "font-family", value: "'Inter'" },
    {
      prop: "unicode-range",
      value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const interCyrillic = localFont({
  src: [{ path: "./inter-cyrillic.woff2", weight: "100 900", style: "normal" }],
  declarations: [
    { prop: "font-family", value: "'Inter'" },
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const interGreekExt = localFont({
  src: [{ path: "./inter-greek-ext.woff2", weight: "100 900", style: "normal" }],
  declarations: [
    { prop: "font-family", value: "'Inter'" },
    { prop: "unicode-range", value: "U+1F00-1FFF" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const interGreek = localFont({
  src: [{ path: "./inter-greek.woff2", weight: "100 900", style: "normal" }],
  declarations: [
    { prop: "font-family", value: "'Inter'" },
    {
      prop: "unicode-range",
      value: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const interVietnamese = localFont({
  src: [{ path: "./inter-vietnamese.woff2", weight: "100 900", style: "normal" }],
  declarations: [
    { prop: "font-family", value: "'Inter'" },
    {
      prop: "unicode-range",
      value:
        "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const interLatinExt = localFont({
  src: [{ path: "./inter-latin-ext.woff2", weight: "100 900", style: "normal" }],
  declarations: [
    { prop: "font-family", value: "'Inter'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export const interLatin = localFont({
  src: [{ path: "./inter-latin.woff2", weight: "100 900", style: "normal" }],
  declarations: [
    { prop: "font-family", value: "'Inter'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  display: "swap",
  preload: true,
  adjustFontFallback: false,
});

const funnelDisplayLatinExt = localFont({
  src: [
    { path: "./funnel-display-latin-ext.woff2", weight: "600", style: "normal" },
    { path: "./funnel-display-latin-ext.woff2", weight: "700", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'Funnel Display'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export const funnelDisplayLatin = localFont({
  src: [
    { path: "./funnel-display-latin.woff2", weight: "600", style: "normal" },
    { path: "./funnel-display-latin.woff2", weight: "700", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'Funnel Display'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  display: "swap",
  preload: true,
  adjustFontFallback: false,
});

const ibmPlexMonoCyrillicExt = localFont({
  src: [
    { path: "./ibm-plex-mono-400-cyrillic-ext.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-mono-500-cyrillic-ext.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    {
      prop: "unicode-range",
      value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const ibmPlexMonoCyrillic = localFont({
  src: [
    { path: "./ibm-plex-mono-400-cyrillic.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-mono-500-cyrillic.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const ibmPlexMonoSymbols2 = localFont({
  src: [
    { path: "./ibm-plex-mono-400-symbols2.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-mono-500-symbols2.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    { prop: "unicode-range", value: "U+2000-2001, U+2004-2008, U+200A, U+23B8-23BD, U+2500-259F" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const ibmPlexMonoVietnamese = localFont({
  src: [
    { path: "./ibm-plex-mono-400-vietnamese.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-mono-500-vietnamese.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const ibmPlexMonoLatinExt = localFont({
  src: [
    { path: "./ibm-plex-mono-400-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-mono-500-latin-ext.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export const ibmPlexMonoLatin = localFont({
  src: [
    { path: "./ibm-plex-mono-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-mono-500-latin.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  display: "swap",
  preload: true,
  adjustFontFallback: false,
});

/** Every subset's faces, kept in the page by layout.tsx's import of this module. */
export const FONT_FACES = [
  interCyrillicExt,
  interCyrillic,
  interGreekExt,
  interGreek,
  interVietnamese,
  interLatinExt,
  interLatin,
  funnelDisplayLatinExt,
  funnelDisplayLatin,
  ibmPlexMonoCyrillicExt,
  ibmPlexMonoCyrillic,
  ibmPlexMonoSymbols2,
  ibmPlexMonoVietnamese,
  ibmPlexMonoLatinExt,
  ibmPlexMonoLatin,
];
