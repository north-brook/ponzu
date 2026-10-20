import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ponzu",
    short_name: "Ponzu",
    description: "The design canvas for your coding agent.",
    start_url: "/",
    display: "browser",
    background_color: "#ffffff",
    theme_color: "#0e0e0e",
    icons: [
      { src: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
  };
}
