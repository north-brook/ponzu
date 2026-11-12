import type { Metadata } from "next";
import { HandoffPage } from "@/components/handoff-page";
import { OpenInApp } from "@/components/open-in-app";
import { canvasAppLink } from "./app-link";

/*
 * Where a link to a canvas in Ponzu Cloud lands: https://ponzu.design/canvases/<id>, as a pull
 * request's description and the agent's messages give it. A browser can't show the canvas (it
 * is the team's, behind their sign-in), so the page hands it to the Mac app as
 * ponzu://canvas/<id>, which opens it for whoever may, or offers the app
 * (components/open-in-app.tsx). `?app=ponzu-dev` hands it to Ponzu Dev instead, `?page=` or
 * `?artboard=` opens it on that page or board, and `?open=` (with `question` or `comment`) opens
 * its thread, pull request or a comment there, as the daily email's links ask (app-link.ts). Links written before canvases had
 * their name, /designs/<id>, land here too (next.config.ts redirects them).
 */

export const metadata: Metadata = {
  title: "Open in Ponzu",
  description: "Open a canvas in Ponzu.",
  robots: { index: false, follow: false },
};

export default async function Page(props: PageProps<"/canvases/[id]">) {
  const { id } = await props.params;
  const { app, page, artboard, open, question, comment } = await props.searchParams;
  const to = canvasAppLink(id, app, { page, artboard, open, question, comment });
  return (
    <HandoffPage>
      <OpenInApp to={to} />
    </HandoffPage>
  );
}
