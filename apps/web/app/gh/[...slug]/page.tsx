import type { Metadata } from "next";
import { GitHub } from "@/components/icons";
import { RetiredLanding } from "@/components/retired";
import { retiredRepo } from "../retired";

/*
 * Ponzu 1's public viewer showed a .design folder from a public GitHub repo at
 * /gh/<owner>/<repo>[@ref]/<path>. It has retired; READMEs and chats still link here, so the page
 * says so and sends the person to the repo, where the folder still is (retired.ts reads the slug).
 */

export const metadata: Metadata = {
  // The layout adds " · Ponzu".
  title: "Viewer retired",
  description: "The public design viewer has retired.",
  robots: { index: false, follow: false },
};

export default async function Page(props: PageProps<"/gh/[...slug]">) {
  const { href, name } = retiredRepo((await props.params).slug);
  return (
    <RetiredLanding
      title="The public design viewer has retired."
      body={
        name
          ? `This was a design folder in ${name} on GitHub, and it's still there.`
          : "This was a design folder on GitHub, and it's still there."
      }
      action={{ href, label: "Open on GitHub", icon: <GitHub /> }}
    />
  );
}
