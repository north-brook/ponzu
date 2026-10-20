import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Variable, so every weight is available and text can use Inter's optical sizes.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Fernwood's display face, for the artboards in the product demo.
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
});

const TITLE = "Ponzu — the design canvas for your coding agent";
const DESCRIPTION =
  "Open source and local. Your coding agent designs in plain HTML and CSS on an infinite canvas, and you steer with comments.";

/*
 * Share previews: the image is app/opengraph-image.jpg (and twitter-image.jpg), rendered from
 * /share by scripts/share-image.ts. Next adds its URL, size and alt text from those files.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://ponzu.design"),
  title: { default: TITLE, template: "%s · Ponzu" },
  description: DESCRIPTION,
  applicationName: "Ponzu",
  authors: [{ name: "Northbrook PBC", url: "https://github.com/north-brook" }],
  creator: "Northbrook PBC",
  publisher: "Northbrook PBC",
  keywords: [
    "design canvas",
    "coding agent",
    "Claude Code",
    "Codex",
    "Cursor",
    "MCP",
    "HTML and CSS",
    "open source",
  ],
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Ponzu",
    locale: "en_US",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    creator: "@brycebjork",
    title: TITLE,
    description:
      "Open source and local. Your agent designs in HTML and CSS; you steer with comments.",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
