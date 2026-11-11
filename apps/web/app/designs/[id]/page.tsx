import type { Metadata } from "next";
import { Lockup } from "@/components/icons";
import { OpenDesign } from "../../local/open-design";

/*
 * Where a link to a design in Ponzu Cloud lands: https://ponzu.design/designs/<id>, as a pull
 * request's description and the agent's messages give it. A browser can't show the design (it
 * is the team's, behind their sign-in), so the page hands it to the Mac app as
 * ponzu://design/<id>, which opens it for whoever may, or offers the app, like /local does for a
 * design on someone's Mac.
 */

export const metadata: Metadata = {
  title: "Open in Ponzu",
  description: "Open a design in Ponzu.",
  robots: { index: false, follow: false },
};

/** A design's id, as the app's ponzu://design/<id> takes it. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async function Page(props: PageProps<"/designs/[id]">) {
  const { id } = await props.params;
  const to = ID.test(id) ? `ponzu://design/${id}` : null;
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
