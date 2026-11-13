/*
 * The legal notices Ponzu's terms and privacy policy promise by email (designs/email.md §1.8),
 * one template switched by notice: billing starts, a price rise, a terms change, a privacy
 * change, shutdown and a suspension. Sent only by the founder's script, never by a trigger;
 * no preference, no List-Unsubscribe.
 *
 * A notice's summary paragraphs are Ponzu's own words, reviewed in a pull request. The one
 * place a person's own text appears in any email is a suspension's reason, which the founder
 * writes: it is rendered as escaped text and refused past `SUSPENSION_REASON_MAX` characters.
 */

import { SITE_URL } from "../brand.ts";
import { Footer, Layout, Mark, Paragraph, Title } from "../components/layout.tsx";
import { Action } from "../components/parts.tsx";
import { type NoticeKind, noticeWords, SUSPENSION_REASON_MAX } from "../words.ts";

/** Where each legal page's history is read: its file's commits in Ponzu's own repository. */
export const LEGAL_HISTORY = {
  terms: "https://github.com/north-brook/ponzu/commits/main/apps/web/app/(legal)/terms/page.mdx",
  privacy:
    "https://github.com/north-brook/ponzu/commits/main/apps/web/app/(legal)/privacy/page.mdx",
} as const;

interface NoticeBase {
  /** Whether replies reach a person (PONZU_EMAIL_REPLY_TO is set). */
  replyTo: boolean;
}

export type NoticeProps = NoticeBase &
  (
    | {
        notice: "billing_starts";
        /** The day it takes effect, in UTC, as people say it ("February 1"). */
        effective: string;
        /** "100 free credits for each member". */
        free: string;
        /** "$0.10". */
        price: string;
        /** "$100". */
        cap: string;
      }
    | { notice: "price_rise"; effective: string; oldPrice: string; newPrice: string }
    | { notice: "terms_change" | "privacy_change"; effective: string; summary: readonly string[] }
    | { notice: "shutdown"; effective: string; summary: readonly string[] }
    | {
        notice: "suspension";
        /** The suspended workspace's name, or null for a person's account. */
        workspaceName: string | null;
        /** The founder's reason, as written. */
        reason: string;
      }
  );

export function subjectOf(props: NoticeProps): string {
  return props.notice === "suspension"
    ? noticeWords.subject.suspension(props.workspaceName)
    : noticeWords.subject[props.notice](props.effective);
}

/** The paragraph under the title, which is also the preview. */
function firstOf(props: NoticeProps): string {
  switch (props.notice) {
    case "billing_starts":
      return noticeWords.billingStarts.first;
    case "price_rise":
      return noticeWords.priceRise.first(props.effective, props.oldPrice, props.newPrice);
    case "terms_change":
    case "privacy_change":
      return props.summary[0] ?? subjectOf(props);
    case "shutdown":
      return noticeWords.shutdown.first;
    case "suspension":
      return noticeWords.suspension.first(props.workspaceName);
  }
}

export function previewOf(props: NoticeProps): string {
  return firstOf(props);
}

function Body(props: NoticeProps) {
  switch (props.notice) {
    case "billing_starts":
      return (
        <>
          <Paragraph>
            {noticeWords.billingStarts.prices(props.free, props.price, props.cap)}
          </Paragraph>
          <Action href={`${SITE_URL}/pricing`} label={noticeWords.billingStarts.action} />
        </>
      );
    case "price_rise":
      return (
        <>
          <Paragraph>{noticeWords.priceRise.when(props.effective)}</Paragraph>
          <Action href={`${SITE_URL}/pricing`} label={noticeWords.priceRise.action} />
        </>
      );
    case "terms_change":
    case "privacy_change": {
      const terms = props.notice === "terms_change";
      const words = terms ? noticeWords.termsChange : noticeWords.privacyChange;
      return (
        <>
          {props.summary.slice(1).map((paragraph, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rendered once.
            <Paragraph key={i}>{paragraph}</Paragraph>
          ))}
          <Action
            href={`${SITE_URL}/${terms ? "terms" : "privacy"}`}
            label={words.action}
            secondary={{
              href: terms ? LEGAL_HISTORY.terms : LEGAL_HISTORY.privacy,
              label: words.history,
            }}
          />
        </>
      );
    }
    case "shutdown":
      return (
        <>
          <Paragraph>{noticeWords.shutdown.takeOut(props.effective)}</Paragraph>
          {props.summary.map((paragraph, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rendered once.
            <Paragraph key={i}>{paragraph}</Paragraph>
          ))}
        </>
      );
    case "suspension":
      return (
        <>
          <Paragraph>{noticeWords.suspension.reasonLead}</Paragraph>
          <Paragraph>{props.reason}</Paragraph>
          <Paragraph>{noticeWords.suspension.appeal}</Paragraph>
        </>
      );
  }
}

export function NoticeEmail(props: NoticeProps) {
  if (props.notice === "suspension" && [...props.reason].length > SUSPENSION_REASON_MAX) {
    throw new Error(`A suspension reason is at most ${SUSPENSION_REASON_MAX} characters.`);
  }
  return (
    <Layout subject={subjectOf(props)} preview={previewOf(props)}>
      <Mark />
      <Title>{subjectOf(props)}</Title>
      <Paragraph>{firstOf(props)}</Paragraph>
      <Body {...props} />
      <Footer reason={noticeWords.footer} reply={props.replyTo} />
    </Layout>
  );
}

export type { NoticeKind };
