/*
 * People joined (designs/email.md §1.5): who joined an organisation's workspace, rolled up, to
 * its admins. No button, because nothing needs doing, and no avatars, so the email fetches
 * nothing from GitHub.
 */
import { Footer, Layout, Mark, Paragraph, Title } from "../components/layout.tsx";
import { PeopleList } from "../components/parts.tsx";
import { nameOf, oneLine } from "../text.ts";
import { LIST_MAX, membersWords, type Person } from "../words.ts";

export interface MembersProps {
  workspaceName: string;
  /** Everyone announced, oldest join first. Never empty. */
  people: readonly Person[];
  /** The workspace's people on Ponzu (owner or member access), the joiners included. */
  total: number;
  unsubscribeUrl: string;
}

export function subjectOf(props: MembersProps): string {
  return membersWords.subject(props.workspaceName, props.people);
}

export function previewOf(props: MembersProps): string {
  return membersWords.total(props.workspaceName, props.total);
}

export function MembersEmail(props: MembersProps) {
  const shown = props.people.slice(0, LIST_MAX).map((person) => {
    const name = person.name ? oneLine(person.name) : "";
    return { name: name ? nameOf(name) : null, login: nameOf(person.login, 39) };
  });
  return (
    <Layout subject={subjectOf(props)} preview={previewOf(props)}>
      <Mark />
      <Title>{`${subjectOf(props)}.`}</Title>
      <PeopleList people={shown} more={props.people.length - shown.length} />
      <Paragraph>{membersWords.paragraph(props.workspaceName, props.total)}</Paragraph>
      <Footer
        reason={membersWords.footer(props.workspaceName)}
        stop={{ href: props.unsubscribeUrl, label: membersWords.stop }}
      />
    </Layout>
  );
}
