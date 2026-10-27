import type { Metadata, Viewport } from "next";
import { Funnel_Display, IBM_Plex_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { DESCRIPTION, TITLE } from "@/components/share";
import "./globals.css";

// Variable, so every weight is available and text can use Inter's optical sizes.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Ponzu's display face: headlines and the wordmark.
const funnelDisplay = Funnel_Display({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-funnel-display",
});

// Ponzu's mono: commands, file names and code on the site.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

// Site-wide defaults. Each page sets its own share tags with `share()` (components/share.ts).
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
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0e0d" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${funnelDisplay.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
