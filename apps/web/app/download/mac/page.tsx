import type { Metadata } from "next";
import { PLATFORMS } from "@/components/platforms";
import { share } from "@/components/share";
import { Guide } from "../guide";
import { MacSteps } from "../steps";

const TITLE = "Download Ponzu for Mac";
const DESCRIPTION =
  "Install Ponzu for Mac: open the disk image, drag it into Applications, and ask your agent for a design.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  ...share({ path: "/download/mac", title: TITLE, description: DESCRIPTION }),
};

const INSTALLER = PLATFORMS.mac.file;

export default async function Page(props: PageProps<"/download/mac">) {
  const query = await props.searchParams;
  return (
    <Guide
      os="mac"
      started={query.start === "1"}
      title="Ponzu for Mac."
      lede="Download it, drag it into Applications, and ask your agent for a design."
      next={
        <>
          open <span className="text-ink">{INSTALLER}</span> from your Downloads folder.
        </>
      }
      steps={<MacSteps installer={INSTALLER} />}
      fine="Signed by Northbrook and notarized by Apple. If macOS asks whether you are sure you want to open an app downloaded from the internet, choose Open. Updates install themselves."
    />
  );
}
