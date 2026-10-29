import type { Metadata } from "next";
import { PLATFORMS } from "@/components/platforms";
import { share } from "@/components/share";
import { Guide } from "../guide";
import { WindowsSteps } from "../other-steps";

const TITLE = "Download Ponzu for Windows";
const DESCRIPTION =
  "Install Ponzu for Windows (beta): run the installer, and ask your agent for a design.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  ...share({ path: "/download/windows", title: TITLE, description: DESCRIPTION }),
};

const INSTALLER = PLATFORMS.windows.file;

export default async function Page(props: PageProps<"/download/windows">) {
  const query = await props.searchParams;
  return (
    <Guide
      os="windows"
      started={query.start === "1"}
      title="Ponzu for Windows."
      lede="Run the installer, and ask your agent for a design."
      next={
        <>
          open <span className="text-ink">{INSTALLER}</span> from your downloads.
        </>
      }
      steps={<WindowsSteps installer={INSTALLER} />}
      fine="Beta, and not signed yet: if Windows says it protected your PC, choose More info, then Run anyway. It installs for you alone, with no administrator needed, and updates itself."
    />
  );
}
