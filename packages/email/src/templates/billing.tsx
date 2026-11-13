/*
 * The four billing emails (the email plan §1.1 to §1.4), one template switched by notice:
 * free credits used, 80% of the cap, the cap reached, and a payment that didn't go through. To
 * every admin (the person, for a personal workspace), can't be turned off, carry no
 * List-Unsubscribe. Calm, not red: the fact is the title, then what waits and the one action
 * that helps.
 *
 * The title and subject are the ping's own first sentence (copy.ts), passed in, so the email and
 * the ping cannot disagree. Dates come formatted in the reader's zone, money as "$100".
 */
import { Footer, Layout, Mark, Paragraph, Title } from "../components/layout.tsx";
import { Action, UsageBar } from "../components/parts.tsx";
import { withoutStop } from "../text.ts";
import { type BillingWho, billingWords } from "../words.ts";

/** The only host a "Pay the invoice" button may point at: Stripe's hosted invoice page. */
export const STRIPE_INVOICE_HOST = "invoice.stripe.com";

interface BillingBase extends BillingWho {
  /** The ping's first sentence, full stop included ("Northbrook reached this month's $100 cap."). */
  headline: string;
  /** Plan and usage on the site (`/settings?section=usage&workspace=…&n=…`). */
  settingsUrl: string;
  /** Whether replies reach a person (PONZU_EMAIL_REPLY_TO is set). */
  replyTo: boolean;
}

export type BillingProps = BillingBase &
  (
    | { notice: "free_used"; periodEnd: string; price: string }
    | { notice: "cap_warning"; periodEnd: string; cap: string; percent: number }
    | { notice: "cap_reached"; periodEnd: string }
    | {
        notice: "payment_failed";
        reason: "failed" | "needs_confirmation";
        graceEnd: string;
        /** Stripe's hosted invoice page, only for an admin GitHub confirmed lately. */
        invoiceUrl: string | null;
      }
  );

/** The invoice link, when it is an https link to Stripe's invoice page; otherwise null. */
export function invoiceHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === STRIPE_INVOICE_HOST
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function subjectOf(props: BillingProps): string {
  return withoutStop(props.headline);
}

export function previewOf(props: BillingProps): string {
  switch (props.notice) {
    case "free_used":
      return billingWords.freeUsed.preview(props, props.periodEnd);
    case "cap_warning":
      return billingWords.capWarning.preview(props.cap, props.periodEnd);
    case "cap_reached":
      return billingWords.capReached.preview(props.periodEnd);
    case "payment_failed":
      return billingWords.paymentFailed.preview(props.graceEnd);
  }
}

function Body(props: BillingProps) {
  switch (props.notice) {
    case "free_used":
      return (
        <>
          <Paragraph>{billingWords.freeUsed.first(props, props.periodEnd)}</Paragraph>
          <Paragraph>{billingWords.freeUsed.second(props, props.price)}</Paragraph>
          <Action href={props.settingsUrl} label={billingWords.freeUsed.action} />
        </>
      );
    case "cap_warning":
      return (
        <>
          <Paragraph>{billingWords.capWarning.first(props, props.cap, props.periodEnd)}</Paragraph>
          <UsageBar percent={props.percent} />
          <Action href={props.settingsUrl} label={billingWords.capWarning.action} />
        </>
      );
    case "cap_reached":
      return (
        <>
          <Paragraph>{billingWords.capReached.first(props, props.periodEnd)}</Paragraph>
          <Action href={props.settingsUrl} label={billingWords.capReached.action} />
        </>
      );
    case "payment_failed": {
      const words = billingWords.paymentFailed;
      const invoice = invoiceHref(props.invoiceUrl);
      const first =
        props.reason === "failed"
          ? words.failed(props, props.graceEnd)
          : words.needsConfirmation(props, props.graceEnd);
      return (
        <>
          <Paragraph>{first}</Paragraph>
          {invoice ? (
            <>
              <Paragraph>{words.payOrChange(props)}</Paragraph>
              <Action
                href={invoice}
                label={props.reason === "failed" ? words.pay : words.open}
                secondary={{ href: props.settingsUrl, label: words.changeCard }}
              />
            </>
          ) : (
            <>
              <Paragraph>{words.changeOnly(props)}</Paragraph>
              <Action href={props.settingsUrl} label={words.fallback} />
            </>
          )}
        </>
      );
    }
  }
}

export function BillingEmail(props: BillingProps) {
  return (
    <Layout subject={subjectOf(props)} preview={previewOf(props)}>
      <Mark />
      <Title>{props.headline}</Title>
      <Body {...props} />
      <Footer reason={billingWords.footer(props)} reply={props.replyTo} />
    </Layout>
  );
}
