import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer, Nav } from "@/components/chrome";
import { REPO } from "@/components/links";
import { share } from "@/components/share";

const TITLE = "Privacy · Ponzu";
const DESCRIPTION =
  "What the Ponzu desktop app, Ponzu for iPhone and ponzu.design collect, where it goes, and how to turn it off.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  ...share({ path: "/privacy", title: TITLE, description: DESCRIPTION }),
};

const ISSUES = `${REPO}/issues`;

// Keep this in step with the code: README.md's Telemetry section, apps/cli/src/telemetry.ts,
// apps/mobile/lib/telemetry.ts and apps/web/instrumentation-client.ts.
export default function Page() {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-ink">
          Privacy.
        </h1>
        <p className="m-0 max-w-[560px] text-[19px]/[31px] text-balance text-muted">
          Ponzu runs on your machine and has no accounts. Your designs stay with you.
        </p>
      </header>

      <article className="mx-auto flex max-w-[640px] flex-col gap-12 text-[16px]/[27px] text-pretty text-muted">
        <Section title="Who we are">
          <p>
            Ponzu is made by Northbrook PBC (“we”). This policy covers the Ponzu desktop app (Mac,
            Windows and Linux), the <Code>ponzu</Code> command line, Ponzu for iPhone and this
            website. Ponzu is open source, so everything here can be checked against{" "}
            <Link href={REPO}>the code on GitHub</Link>.
          </p>
        </Section>

        <Section title="Your designs">
          <p>
            A design is a folder of files on your disk. Ponzu never uploads it to us. Agents work on
            it over MCP on the same computer, and Ponzu never sees your prompts. A few things in a
            design do reach other servers, because they would in any browser: fonts it names are
            loaded from Google Fonts, and images it links to are fetched from wherever they live.
            Opening a design from GitHub clones its repository from GitHub.
          </p>
        </Section>

        <Section title="The desktop app">
          <p>
            The desktop app sends pseudonymous usage data to us through PostHog, in the US: which
            tools agents call and whether they fail (with a coarse reason, like a timeout), which
            agents connect, how often the canvas opens and comments are left, and the Ponzu version
            and OS. No HTML, file names, paths, comment text or tool arguments are sent.
          </p>
          <p>
            Each install is a random id. When Tailscale is running, that id is linked to a hash of
            your Tailscale user id, so we count people rather than machines. Your Tailscale name and
            email are never sent.
          </p>
          <p>
            Agents can tell us how Ponzu is working for them with the <Code>send_feedback</Code>{" "}
            tool. That is the one event with words in it: a short note the agent writes about Ponzu,
            not your work.
          </p>
          <p>
            Turn all of it off with <Code>ponzu telemetry off</Code>, or set{" "}
            <Code>PONZU_TELEMETRY=0</Code> or <Code>DO_NOT_TRACK=1</Code>. Builds from source send
            nothing. To check for updates, the app downloads release information from GitHub.
          </p>
        </Section>

        <Section title="Ponzu for iPhone">
          <p>
            The iPhone app talks to Ponzu on your own Macs over your Tailscale network, and shows
            their designs. It looks on your Wi-Fi only to find a Mac to pair with; it always reaches
            a Mac by its Tailscale name. What it keeps (the Macs you paired, recent designs and
            their previews) stays on the phone.
          </p>
          <p>
            It asks for local network access to find your Macs, the camera to scan a Mac’s pairing
            code, and the microphone and speech recognition to dictate comments. Dictation runs on
            the phone; your voice is not sent to us or to Apple.
          </p>
          <p>
            It sends the same kind of pseudonymous usage data as the Mac app (the app opening, a Mac
            paired, a design opened, a comment left with no comment text, the Activity tab opened,
            an agent’s link opened), and, for one gesture on the canvas in twenty, how smoothly it
            moved: frame timings and how many boards the page has, nothing of the design. It decides
            from the Macs it has heard from: it sends only when they all have telemetry on, and
            stops as soon as it hears from one that has it off. Events from before any Mac answers
            wait until one does. App updates come from Expo, which delivers them.
          </p>
        </Section>

        <Section title="This website">
          <p>
            ponzu.design is hosted on Vercel and counts page views (with how far down you scrolled)
            and download clicks with PostHog, which keeps a cookie to tell visits apart.
          </p>
          <p>
            So we know when the site breaks, it also sends errors in its own code, with their stack
            traces; how fast each page loads and responds (Core Web Vitals); and whether a page
            stayed open for a few seconds or was closed by the browser running out of memory. That
            last one keeps a marker in the tab’s session storage while the page is open, and no
            more. These events carry the page, browser, operating system and type of device, never
            anything you type. The site makes no session recordings.
          </p>
          <p>
            It all honors Do Not Track. Pages that show a design from GitHub read it from GitHub’s
            public servers. The site has no sign-in and doesn’t sell or share data with advertisers.
          </p>
        </Section>

        <Section title="What we don’t do">
          <p>
            We don’t sell data, show ads, or track you across other apps and websites. We use what
            we collect only to understand how Ponzu is used and to make it better.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions, or a request to delete data tied to your install id: open an issue on{" "}
            <Link href={ISSUES}>GitHub</Link>. If this policy changes, the change shows up here and
            in the repository’s history.
          </p>
          <p className="text-[13px]/[19px] text-faint">Last updated October 27, 2026.</p>
        </Section>
      </article>

      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 [&_p]:m-0">
      <h2 className="m-0 text-[22px]/[30px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="text-ink underline decoration-outline underline-offset-4 hover:decoration-ink"
      href={href}
    >
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-chip px-1.5 py-0.5 font-mono text-[14px] text-ink">{children}</code>
  );
}
