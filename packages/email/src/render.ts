/*
 * One email, rendered: its subject, preview, HTML and text part, before the API's mail seam
 * (apps/api/src/deps/mail.ts), so `resend` stays imported by one file and Resend's `react`
 * field is never used. Deterministic: no clock, no random ids, every date and amount arrives
 * as a finished string, so a retry sends the same bytes under the same idempotency key.
 */
import { createElement, type ReactElement } from "react";
import { render, toPlainText } from "react-email";
import * as billing from "./templates/billing.tsx";
import * as digest from "./templates/digest.tsx";
import * as members from "./templates/members.tsx";
import * as notice from "./templates/notice.tsx";
import * as recap from "./templates/recap.tsx";

/** What each kind of email takes. The kinds are the API's (apps/api/src/email/kinds.ts). */
export interface EmailProps {
  digest: digest.DigestProps;
  billing: billing.BillingProps;
  team: members.MembersProps;
  recap: recap.RecapProps;
  notice: notice.NoticeProps;
}

export type EmailKind = keyof EmailProps;

export interface RenderedEmail {
  subject: string;
  preview: string;
  html: string;
  text: string;
}

interface Template<P> {
  subjectOf(props: P): string;
  previewOf(props: P): string;
  element(props: P): ReactElement;
}

const TEMPLATES: { [K in EmailKind]: Template<EmailProps[K]> } = {
  digest: { ...digest, element: (props) => createElement(digest.DigestEmail, props) },
  billing: { ...billing, element: (props) => createElement(billing.BillingEmail, props) },
  team: { ...members, element: (props) => createElement(members.MembersEmail, props) },
  recap: { ...recap, element: (props) => createElement(recap.RecapEmail, props) },
  notice: { ...notice, element: (props) => createElement(notice.NoticeEmail, props) },
};

export const EMAIL_KINDS = Object.keys(TEMPLATES) as EmailKind[];

/**
 * The text part's shape: headings keep their case (html-to-text shouts them by default), and
 * each row of a list (a table, for classic Outlook) is a line of its own.
 */
const TEXT_OPTIONS = {
  selectors: [
    ...["h1", "h2", "h3"].map((selector) => ({
      selector,
      options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 },
    })),
    { selector: "table", format: "block" },
    { selector: "tr", format: "block", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "td", format: "inline" },
  ],
};

export async function renderEmail<K extends EmailKind>(
  kind: K,
  props: EmailProps[K],
): Promise<RenderedEmail> {
  const template = TEMPLATES[kind] as Template<EmailProps[K]>;
  const html = await render(template.element(props));
  return {
    subject: template.subjectOf(props),
    preview: template.previewOf(props),
    html,
    text: `${toPlainText(html, TEXT_OPTIONS).trim()}\n`,
  };
}
