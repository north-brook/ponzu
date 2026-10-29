import type { Metadata } from "next";
import { asset, PLATFORMS } from "@/components/platforms";
import { share } from "@/components/share";
import { FineLink, Guide } from "../guide";
import { LinuxSteps } from "../other-steps";

const TITLE = "Download Ponzu for Linux";
const DESCRIPTION =
  "Install Ponzu for Linux (beta): an AppImage for any distribution, or a .deb for Debian and Ubuntu.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  ...share({ path: "/download/linux", title: TITLE, description: DESCRIPTION }),
};

const { file: INSTALLER, alt: DEB = "Ponzu-x64.deb" } = PLATFORMS.linux;

export default async function Page(props: PageProps<"/download/linux">) {
  const query = await props.searchParams;
  return (
    <Guide
      os="linux"
      started={query.start === "1"}
      title="Ponzu for Linux."
      lede="Download the AppImage, let it run, and ask your agent for a design."
      next={
        <>
          allow <span className="text-ink">{INSTALLER}</span> to run as a program and open it.
        </>
      }
      steps={<LinuxSteps installer={INSTALLER} />}
      fine={
        <>
          Beta, for x64. On Debian or Ubuntu you can use the{" "}
          <FineLink href={asset(DEB)}>.deb</FineLink> instead:{" "}
          <code className="font-mono text-ink">sudo apt install ./{DEB}</code>. Both update
          themselves; the .deb asks for your password to. The AppImage needs libfuse2 (on Ubuntu
          24.04 and later, <code className="font-mono text-ink">libfuse2t64</code>) and keeps its
          name, since updates replace it in place.
        </>
      }
    />
  );
}
