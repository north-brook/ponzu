import type { Metadata } from "next";
import { Lockup } from "@/components/icons";
import { OpenDesign } from "./open-design";

/*
 * Where an agent's link to a design on the person's Macs lands:
 * https://ponzu.design/local#mac=<name>&file=<path>&artboard=<id>, beside /gh for one on GitHub.
 * Chats drop ponzu:// links, so agents hand out this page, which passes the design on to the Mac
 * app or offers the download. Links from before it was /local come through /open's redirect. As
 * designed in .context/open-link.design.
 */

export const metadata: Metadata = {
  title: "Open in Ponzu",
  description: "Open a design your agent made in Ponzu for Mac.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[1440px] flex-col px-16 max-[720px]:px-5">
      <div className="flex h-[82px] items-center">
        <Lockup size={23} />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center pb-[82px]">
        <OpenDesign />
      </main>
    </div>
  );
}
