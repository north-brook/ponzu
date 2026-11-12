import type { Metadata } from "next";
import {
  type Entry,
  latestChangelog,
  noteParts,
  releaseDay,
  releaseName,
} from "@/components/changelog";
import { Footer, Nav } from "@/components/chrome";
import { REPO } from "@/components/links";
import { Code, H2, Link, P, Prose, Ul } from "@/components/prose";
import { share } from "@/components/share";

const TITLE = "Changelog · Ponzu";
const DESCRIPTION = "What’s new in Ponzu, from each release’s notes.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  ...share({ path: "/changelog", title: TITLE, description: DESCRIPTION }),
};

/** As often as the notes are read (components/changelog.ts), so a fallback is retried too. */
export const revalidate = 3600;

const RELEASE_LIST = `${REPO}/releases`;

/**
 * Every release's notes since Ponzu Cloud's first, both apps together, newest first. The notes are
 * the ones each pull request wrote (docs/release-notes.md), read from the latest release's
 * changelog.json. When that can't be read the page says so and points at GitHub's releases.
 */
export default async function Page() {
  const entries = await latestChangelog();
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-ink">
          Changelog.
        </h1>
        <p className="m-0 max-w-[560px] text-[19px]/[31px] text-balance text-muted">
          {DESCRIPTION}
        </p>
      </header>

      <Prose>
        {entries === null ? (
          <P>
            The release notes couldn’t be loaded. They’re on <Link href={RELEASE_LIST}>GitHub</Link>
            .
          </P>
        ) : entries.length === 0 ? (
          <P>
            No release has notes here yet. Every release is on{" "}
            <Link href={RELEASE_LIST}>GitHub</Link>.
          </P>
        ) : (
          entries.map((entry) => <Release key={`${entry.app}-${entry.version}`} entry={entry} />)
        )}
      </Prose>

      <Footer />
    </div>
  );
}

function Release({ entry }: { entry: Entry }) {
  return (
    <section id={`${entry.app}-${entry.version}`} className="flex scroll-mt-24 flex-col gap-4">
      <H2>
        {releaseName(entry)}
        <span className="font-normal text-muted">
          {" · "}
          <time className="whitespace-nowrap" dateTime={entry.date}>
            {releaseDay(entry.date)}
          </time>
        </span>
      </H2>
      <Ul>
        {entry.notes.map((note, n) => (
          // Two pull requests can write the same note, so its place in the release is its key.
          // biome-ignore lint/suspicious/noArrayIndexKey: a release's notes never reorder
          <li key={n}>
            {noteParts(note).map((part, i) =>
              // The parts of one note never reorder, so their place is their key.
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sequence
              part.code ? <Code key={i}>{part.text}</Code> : <span key={i}>{part.text}</span>,
            )}
          </li>
        ))}
      </Ul>
    </section>
  );
}
