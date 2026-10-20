import { getImageProps } from "next/image";
import type { ReactNode } from "react";
import { Footer, Nav } from "@/components/chrome";
import { CopyChip } from "@/components/copy-chip";
import { Wedge } from "@/components/icons";
import { DownloadButton, OutlineButton, REPO } from "@/components/links";

const well =
  "m-0 flex-1 overflow-auto whitespace-pre rounded-[14px] px-5 py-[18px] font-mono text-[13px]/6";
const wellLight = `${well} bg-well text-text shadow-[inset_0_0_0_1px_var(--well-rule)]`;
const wellDark = `${well} bg-code text-code-ink shadow-[inset_0_0_0_1px_var(--code-rule)]`;

const screenshot = {
  width: 2272,
  height: 1420,
  sizes: "(max-width: 1240px) 100vw, 1136px",
  priority: true,
};
const { props: dark } = getImageProps({ ...screenshot, alt: "", src: "/app-dark.png" });
const { props: light } = getImageProps({ ...screenshot, alt: "", src: "/app-light.png" });

export default function Home() {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-[104px] pb-16 text-center max-[720px]:pt-14">
        <h1 className="m-0 max-w-[1040px] text-[clamp(48px,7vw,96px)] leading-[.96] font-medium tracking-[-0.04em] text-balance text-ink">
          The design canvas for your coding agent.
        </h1>
        <p className="m-0 max-w-[620px] text-[21px]/[31px] text-pretty text-muted">
          Open source. Runs on your machine. Your agent designs in plain HTML and CSS, and you steer
          with comments.
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-3">
          <DownloadButton>Download for Mac</DownloadButton>
          <CopyChip text="bunx ponzu serve" />
        </div>
      </header>

      <div className="mt-4 mb-28 flex items-center justify-center rounded-3xl bg-stage p-12 max-[720px]:rounded-2xl max-[720px]:p-3">
        <picture className="block w-full max-w-[1136px]">
          <source srcSet={dark.srcSet} media="(prefers-color-scheme: dark)" />
          <img
            {...light}
            alt="Ponzu showing a plant shop's hero with three headline variations side by side and an open comment thread."
            className="block h-auto w-full rounded-xl shadow-[0_30px_70px_var(--stage-shadow)]"
          />
        </picture>
      </div>

      <section className="flex flex-col gap-4 pb-[120px]">
        <div className="flex gap-4 max-[1100px]:flex-col">
          <Tile className="w-[520px] shrink-0 flex-col justify-between gap-10 max-[1100px]:w-auto">
            <Head title="Free forever.">
              Open source, MIT. No account, no seats, no limits. Bring the agent you already use.
            </Head>
            <div className="flex items-baseline gap-2.5">
              <b className="text-[120px]/[100px] font-semibold tracking-[-0.06em] text-ink">$0</b>
              <span className="text-base text-faint">forever</span>
            </div>
          </Tile>
          <Tile className="flex-1 flex-col">
            <Head title="Your files, your workflow.">
              A .design is a folder on your disk. Commit it, sync it, or toss it, and embed the
              canvas in your own product.
            </Head>
            <div className="flex gap-3 max-[720px]:flex-col">
              <pre className={wellLight}>
                {`~/code/fernwood
├─ src/
└─ design/fernwood.design
   ├─ tokens.css
   └─ pages/home/hero.html`}
              </pre>
              <pre className={wellDark}>
                {`$ git diff design/
- <h1>Plants that outlive
-   your lease.</h1>
+ <h1>Outlive your
+   lease.</h1>`}
              </pre>
            </div>
          </Tile>
        </div>
        <Tile className="flex-row items-center gap-14 max-[1100px]:flex-col max-[1100px]:items-stretch">
          <Head title="Just HTML and CSS." className="w-[420px] shrink-0 max-[1100px]:w-auto">
            If a browser can do it, so can your design: grid, gradients, variable fonts, video, real
            animation. Nothing is approximated.
          </Head>
          <div className="flex min-w-0 flex-1 gap-3 max-[720px]:flex-col">
            <div
              aria-hidden="true"
              className="flex h-40 min-w-0 flex-1 items-center justify-center gap-5 rounded-[14px] bg-well p-5 shadow-[inset_0_0_0_1px_var(--well-rule)]"
            >
              {[0, 0.12, 0.24, 0.36].map((delay) => (
                <i
                  key={delay}
                  style={{ animationDelay: `${delay}s` }}
                  className="block size-12 flex-[0_0_48px] rounded-[15px] bg-m2 animate-pop motion-reduce:animate-none"
                />
              ))}
            </div>
            <pre
              className={`${wellDark} min-w-0 flex-[0_1_340px] text-xs/[21px] max-[1100px]:flex-none`}
            >
              {`.card {
  animation: pop 360ms
    cubic-bezier(.3,1.6,.5,1);
}
@keyframes pop {
  from { scale: .7; opacity: .3 }
}`}
            </pre>
          </div>
        </Tile>
      </section>

      <section className="flex flex-col items-center gap-7 pt-10 pb-14 text-center">
        <Wedge size={72} />
        <h2 className="m-0 text-[clamp(36px,5vw,56px)] leading-[1.04] font-medium tracking-[-0.04em] text-ink">
          Give your agent a canvas.
        </h2>
        <div className="flex flex-wrap justify-center gap-3 pt-3">
          <DownloadButton>Download for Mac</DownloadButton>
          <OutlineButton href={REPO}>View on GitHub</OutlineButton>
        </div>
        <Footer />
      </section>
    </div>
  );
}

function Tile({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`flex gap-7 rounded-3xl bg-tile p-10 max-[720px]:p-7 ${className}`}>
      {children}
    </div>
  );
}

function Head({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <h2 className="m-0 text-4xl/10 font-medium tracking-[-0.03em] text-ink">{title}</h2>
      <p className="m-0 max-w-[520px] text-[17px]/[26px] text-pretty text-muted">{children}</p>
    </div>
  );
}
