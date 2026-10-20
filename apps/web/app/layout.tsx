import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { DESCRIPTION, TITLE } from "@/components/share";
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
