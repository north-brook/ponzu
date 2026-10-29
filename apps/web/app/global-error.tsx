"use client";

import { useEffect } from "react";
import { reportError } from "@/components/report-error";

// The root layout itself threw: this replaces it, so it brings its own document and styles.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => reportError(error, "root"), [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          textAlign: "center",
          font: "16px/1.6 system-ui, sans-serif",
          colorScheme: "light dark",
        }}
      >
        <main>
          <title>Ponzu</title>
          <h1 style={{ margin: "0 0 12px", fontSize: 32, letterSpacing: "-0.02em" }}>
            Something broke.
          </h1>
          <p style={{ margin: "0 0 24px", opacity: 0.7 }}>
            ponzu.design hit an error. Trying again often gets past it.
          </p>
          <button type="button" onClick={retry} style={{ font: "inherit", padding: "8px 20px" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
