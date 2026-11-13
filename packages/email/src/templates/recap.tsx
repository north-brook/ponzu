/*
 * The Friday recap (the email plan §1.6 and §5): the canvases a person owns whose pull
 * requests merged this week, newest merge first. Canvas names and pull request numbers only:
 * no repository names, no pull request titles (the agent wrote them), no pictures, no hours,
 * no credits and no call to do more. The counts-only form carries no canvas name anywhere.
 */
import { DateLine, Footer, Layout, Mark, Paragraph, Title } from "../components/layout.tsx";
import { CanvasList } from "../components/parts.tsx";
import { nameOf } from "../text.ts";
import { LIST_MAX, recapWords } from "../words.ts";

export interface RecapCanvas {
  name: string;
  /** The canvas on the site, opening its pull request (`/canvases/<id>?open=pull-request`). */
  href: string;
  workspaceName: string;
  /** Its pull requests merged this week, in merge order. Never empty. */
  numbers: readonly number[];
  /** The weekday of its newest merge in the reader's zone ("Tuesday"). */
  weekday: string;
}

export interface RecapProps {
  /** This Friday in the reader's zone ("Friday, November 13"). */
  date: string;
  /** Newest merge first. Never empty: a quiet week sends nothing. */
  canvases: readonly RecapCanvas[];
  /** The first recap this person ever gets: it introduces itself. */
  first: boolean;
  /** Counts only, no canvas names (the founder's choice, the email plan §1.6). */
  countsOnly: boolean;
  unsubscribeUrl: string;
}

const pullRequestsIn = (props: RecapProps) =>
  props.canvases.reduce((sum, canvas) => sum + canvas.numbers.length, 0);

export function subjectOf(props: RecapProps): string {
  return props.countsOnly
    ? recapWords.countsSubject(props.canvases.length, pullRequestsIn(props))
    : recapWords.subject(props.canvases.map((canvas) => canvas.name));
}

export function previewOf(props: RecapProps): string {
  const [only] = props.canvases;
  if (pullRequestsIn(props) === 1 && only?.numbers[0] !== undefined) {
    return recapWords.previewOne(only.numbers[0], only.weekday);
  }
  return recapWords.previewMany(pullRequestsIn(props));
}

export function RecapEmail(props: RecapProps) {
  const workspaces = new Set(props.canvases.map((canvas) => canvas.workspaceName));
  const shown = props.canvases.slice(0, LIST_MAX).map((canvas) => ({
    name: nameOf(canvas.name),
    href: canvas.href,
    numbers: recapWords.numbers(canvas.numbers),
    rest:
      recapWords.merged(canvas.numbers.length, canvas.weekday) +
      (workspaces.size > 1 ? ` · ${nameOf(canvas.workspaceName)}` : ""),
  }));
  const more = props.canvases.length - shown.length;
  return (
    <Layout subject={subjectOf(props)} preview={previewOf(props)}>
      <Mark />
      <DateLine>{props.date}</DateLine>
      <Title large>{recapWords.title}</Title>
      <Paragraph>{recapWords.lede}</Paragraph>
      {props.countsOnly ? (
        <Paragraph>
          {recapWords.countsParagraph(props.canvases.length, pullRequestsIn(props))}
        </Paragraph>
      ) : (
        <>
          <CanvasList canvases={shown} />
          {more > 0 ? <Paragraph muted>{recapWords.moreCanvases(more)}</Paragraph> : null}
        </>
      )}
      {props.first ? <Paragraph muted>{recapWords.first}</Paragraph> : null}
      <Paragraph>{recapWords.closing}</Paragraph>
      <Footer
        reason={recapWords.footer}
        stop={{ href: props.unsubscribeUrl, label: recapWords.stop }}
      />
    </Layout>
  );
}
