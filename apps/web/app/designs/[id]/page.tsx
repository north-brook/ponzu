import type { Metadata } from "next";
import { Lockup } from "@/components/icons";
import { OpenDesign } from "../../local/open-design";
import { designAppLink } from "./app-link";

/*
 * Where a link to a design in Ponzu Cloud lands: https://ponzu.design/designs/<id>, as a pull
 * request's description and the agent's messages give it. A browser can't show the design (it
 * is the team's, behind their sign-in), so the page hands it to the Mac app as
 * ponzu://design/<id>, which opens it for whoever may, or offers the app, like /local does for a
 * design on someone's Mac. `?app=ponzu-preview` hands it to Ponzu Preview instead, and `?page=` or
 * `?artboard=` opens it on that page or board (app-link.ts).
 */

export const metadata: Metadata = {
  title: "Open in Ponzu",
  description: "Open a design in Ponzu.",
  robots: { index: false, follow: false },
};

export default async function Page(props: PageProps<"/designs/[id]">) {
  const { id } = await props.params;
  const { app, page, artboard } = await props.searchParams;
  const to = designAppLink(id, app, { page, artboard });
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
