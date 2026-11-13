import type { Metadata } from "next";
import { HandoffPage } from "@/components/handoff-page";
import { OpenInApp } from "@/components/open-in-app";
import { settingsAppLink } from "./app-link";

/*
 * Where an email's link to Settings lands: https://ponzu.design/settings?section=usage&workspace=
 * <id>&n=<notification id>, as a billing email's "Add a card" gives it. A mail app may not open
 * an app's own scheme, so the email links here and the page hands it to the Mac app as
 * ponzu://settings?…, which opens that section on that workspace, or offers the app
 * (components/open-in-app.tsx). `?app=ponzu-dev` hands it to Ponzu Dev instead, as development's
 * emails ask. Anything in the address the link grammar doesn't take is dropped (app-link.ts).
 */

export const metadata: Metadata = {
  title: "Open in Ponzu",
  description: "Open Settings in Ponzu.",
  robots: { index: false, follow: false },
};

export default async function Page(props: PageProps<"/settings">) {
  const { app, section, workspace, n } = await props.searchParams;
  const to = settingsAppLink(app, { section, workspace, n });
  return (
    <HandoffPage>
      <OpenInApp to={to} what="settings" />
    </HandoffPage>
  );
}
