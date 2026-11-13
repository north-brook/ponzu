/*
 * The daily digest (the email plan §1.7), restyled: canvas-first subjects, each group's name
 * as a heading and its ping sentences as link rows. The sentences are copy.ts's, passed in.
 */
import { Footer, Layout, Mark, Paragraph, Title } from "../components/layout.tsx";
import { LinkRows } from "../components/parts.tsx";
import { BODY_NAME_MAX, listOf, nameOf, SUBJECT_NAME_MAX, withoutStop } from "../text.ts";
import { digestWords } from "../words.ts";

export interface DigestLine {
  /** The ping's sentence, as copy.ts wrote it. */
  text: string;
  /** Where the line opens, on the site; null when it opens nothing. */
  href: string | null;
}

export interface DigestGroup {
  /** The canvas's name, or for billing the workspace's. */
  name: string;
  /** A workspace's billing lines rather than a canvas's. */
  billing: boolean;
  /** Oldest first, at most ten. */
  lines: readonly DigestLine[];
  /** Lines left out past the ten. */
  more: number;
}

export interface DigestProps {
  /** Newest first. Never empty: an empty digest is not sent. */
  groups: readonly DigestGroup[];
  unsubscribeUrl: string;
}

/** A group's name: the canvas's, or "Northbrook's plan" for a workspace's billing lines. */
function nameIn(group: DigestGroup, max: number): string {
  return group.billing ? digestWords.plan(group.name) : nameOf(group.name, max);
}

const thingsIn = (groups: readonly DigestGroup[]) =>
  groups.reduce((sum, group) => sum + group.lines.length + group.more, 0);

export function subjectOf({ groups }: DigestProps): string {
  const [first] = groups;
  if (!first) return digestWords.title;
  const things = thingsIn(groups);
  const line = first.lines[0];
  if (groups.length === 1 && things === 1 && line) {
    return first.billing
      ? withoutStop(line.text)
      : `${nameIn(first, SUBJECT_NAME_MAX)}: ${withoutStop(line.text)}`;
  }
  const rest = groups.slice(1);
  const names =
    groups.length <= 2
      ? listOf(groups.map((group) => nameIn(group, SUBJECT_NAME_MAX)))
      : `${nameIn(first, SUBJECT_NAME_MAX)} and ${digestWords.more(
          rest.length,
          rest.every((group) => !group.billing),
        )}`;
  return `${names}: ${digestWords.things(things)}`;
}

/** The newest line's sentence. */
export function previewOf({ groups }: DigestProps): string {
  return groups[0]?.lines.at(-1)?.text ?? digestWords.intro;
}

export function DigestEmail(props: DigestProps) {
  return (
    <Layout subject={subjectOf(props)} preview={previewOf(props)}>
      <Mark />
      <Title>{digestWords.title}</Title>
      <Paragraph>{digestWords.intro}</Paragraph>
      <LinkRows
        groups={props.groups.map((group) => ({
          name: nameIn(group, BODY_NAME_MAX),
          lines: group.lines,
          more: group.more,
        }))}
      />
      <Footer
        reason={digestWords.footer}
        stop={{ href: props.unsubscribeUrl, label: digestWords.stop }}
      />
    </Layout>
  );
}
