import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "@/components/ui/dialog";
import { pairUrl, qrPath } from "@/lib/pair";
import { PairBody, type PairMachine } from "./pair-iphone.tsx";

const render = (machine: PairMachine | null) =>
  renderToStaticMarkup(
    <Dialog open>
      <PairBody machine={machine} />
    </Dialog>,
  );

test("the code says where this Mac is on the tailnet, and nothing else", () => {
  expect(pairUrl("macbook.tail1.ts.net")).toBe("ponzu://pair?host=macbook.tail1.ts.net&v=1");
  const html = render({ name: "macbook", dns: "macbook.tail1.ts.net" });
  expect(html).toContain('data-pair="ponzu://pair?host=macbook.tail1.ts.net&amp;v=1"');
  expect(html).toContain("Open Ponzu on your iPhone and scan this code.");
  expect(html).toContain("On your tailnet as macbook");
});

test("a QR code is square, with a finder pattern in its corner", () => {
  const { size, d } = qrPath(pairUrl("macbook.tail1.ts.net"));
  // Versions are 21 modules plus 4 a step.
  expect((size - 21) % 4).toBe(0);
  // The top-left finder's first row is a run of seven dark modules.
  expect(d.startsWith("M0 0h7v1h-7z")).toBe(true);
});

test("without Tailscale, it says to turn it on instead of showing a code", () => {
  const html = render({ name: null, dns: null });
  expect(html).toContain("Turn on Tailscale on this Mac to pair an iPhone.");
  expect(html).not.toContain("data-pair");
});

test("without MagicDNS, there's no name for the phone to find, so no code either", () => {
  const html = render({ name: "macbook", dns: null });
  expect(html).toContain("Turn on MagicDNS");
  expect(html).not.toContain("data-pair");
});
