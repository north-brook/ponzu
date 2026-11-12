import type { Metadata } from "next";
import { Lockup } from "@/components/icons";
import { OpenDesign } from "../../local/open-design";
import { canvasAppLink } from "./app-link";

/*
 * Where a link to a canvas in Ponzu Cloud lands: https://ponzu.design/canvases/<id>, as a pull
 * request's description and the agent's messages give it. A browser can't show the canvas (it
 * is the team's, behind their sign-in), so the page hands it to the Mac app as
 * ponzu://canvas/<id>, which opens it for whoever may, or offers the app, like /local does for a
 * canvas on someone's Mac. `?app=ponzu-dev` hands it to Ponzu Dev instead, and `?page=` or
 * `?artboard=` opens it on that page or board (app-link.ts).
 */

export const metadata: Metadata = {
  title: "Open in Ponzu",
  description: "Open a canvas in Ponzu.",
  robots: { index: false, follow: false },
};

export default async function Page(props: PageProps<"/canvases/[id]">) {
  const { id } = await props.params;
  const { app, page, artboard } = await props.searchParams;
  const to = canvasAppLink(id, app, { page, artboard });
  return (
    <div className="mx-auto flex min-h-dvh max-w-[1440px] flex-col px-16 max-[720px]:px-5">
      <div className="flex h-[82px] items-center">
        <Lockup size={23} />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center pb-[82px]">
        <OpenDesign to={to} />
      </main>
    </div>
  );
}
