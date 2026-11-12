import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DEVICE_SCRIPT } from "@/components/device";
import { Handoff } from "@/components/handoff";
import { DESCRIPTION, TITLE } from "@/components/share";
// The site's fonts, served from fonts/ (fonts.ts).
import "@/fonts/fonts";
import "./globals.css";

// Site-wide defaults. Each page sets its own share tags with `share()` (components/share.ts).
export const metadata: Metadata = {
  metadataBase: new URL("https://ponzu.design"),
  title: { default: TITLE, template: "%s · Ponzu" },
  description: DESCRIPTION,
  applicationName: "Ponzu",
  authors: [{ name: "Northbrook PBC", url: "https://github.com/north-brook" }],
  creator: "Northbrook PBC",
  publisher: "Northbrook PBC",
  keywords: ["canvas", "Claude Code", "pull requests", "AI agent", "cloud sandbox", "open source"],
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
    // The device script marks phones on <html> before it paints (components/device.ts).
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script of our own, run before paint */}
        <script dangerouslySetInnerHTML={{ __html: DEVICE_SCRIPT }} />
      </head>
      <body>
        {children}
        <Handoff />
      </body>
    </html>
  );
}
