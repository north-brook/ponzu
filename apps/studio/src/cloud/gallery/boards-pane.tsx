/*
 * The open canvas's boards in the main pane, drawn by the canvas package as the app draws them
 * (app/canvas.tsx's BoardsView), from a document in memory. Only with `&boards` in the address:
 * the site's product shots ask for it (`visual.ts shots`), and the references leave it out, so
 * they keep the pane empty and are about the window alone.
 */
import { Canvas, MemorySource } from "@ponzu/canvas";
import type { Doc } from "@ponzu/core";
import { useMemo } from "react";
import { useColorScheme } from "../ui/color-scheme.ts";
import * as f from "./fixtures.ts";
import "../../pz.css";

/** Whether this gallery page draws the boards (`&boards`). */
export const SHOW_BOARDS =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("boards");

export function BoardsPane({
  doc,
  page,
  onPage,
}: {
  doc: Doc;
  page?: string;
  onPage?: (id: string) => void;
}) {
  const source = useMemo(() => new MemorySource(structuredClone(doc)), [doc]);
  const theme = useColorScheme();
  return (
    <Canvas
      source={source}
      me={{
        kind: "user",
        id: f.ada.id,
        name: f.ada.name,
        ...(f.ada.avatarUrl ? { avatarUrl: f.ada.avatarUrl } : {}),
      }}
      theme={theme}
      readOnly
      pageBar={false}
      {...(page ? { page } : {})}
      {...(onPage ? { onPageChange: onPage } : {})}
    />
  );
}
