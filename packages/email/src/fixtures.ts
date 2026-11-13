/*
 * Named sample emails: every template and variant, with hostile names among them. The tests
 * render each one and pin its subject, preview and text part (expected/<name>.txt); the
 * pictures (scripts/shots.ts) and the preview server (emails/) draw them.
 *
 * The examples follow designs/email.md §1: a workspace "Northbrook", a $100 cap, a period that
 * resets at midnight UTC on December 9, a payment of $123.40 and a reader in New York.
 */
import { SITE_URL } from "./brand.ts";
import type { EmailKind, EmailProps } from "./render.ts";
import type { BillingProps } from "./templates/billing.tsx";
import type { DigestGroup } from "./templates/digest.tsx";
import type { RecapCanvas } from "./templates/recap.tsx";
import type { Person } from "./words.ts";

export const API_URL = "https://api.ponzu.design";
const unsubscribe = (category: string) =>
  `${API_URL}/v1/email/unsubscribe?t=usr_1.${category}.pzv1.sealed-token`;
const settings = `${SITE_URL}/settings?section=usage&workspace=ws_northbrook&n=ntf_1`;
const invoice = "https://invoice.stripe.com/i/acct_test/test_invoice";
const canvas = (id: string, open = "thread") => `${SITE_URL}/canvases/${id}?open=${open}`;

/** Names a person could give a canvas or a workspace, to break the render with. */
export const HOSTILE = {
  long: "Kettle onboarding flow for the new self-serve pricing experiment, take two",
  markup: '<b>Q4 & "launch"</b>',
  rtl: "תכנון השקה של קומקום",
  emoji: "Launch 🚀👩🏽‍💻 board",
  script: '<script>alert("x")</script>',
} as const;

const org = { workspaceName: "Northbrook", personal: false, replyTo: true };
const personal = { workspaceName: "maya", personal: true, replyTo: false };

const billing = (props: BillingProps) => props;

const people = (n: number): Person[] =>
  [
    { name: "Maya Chen", login: "mayachen" },
    { name: "Sam Okafor", login: "sokafor" },
    { name: null, login: "lee-park" },
    { name: "Ana Souza", login: "anasouza" },
    { name: "Ravi Iyer", login: "ravi" },
    { name: "Jo Kim", login: "jokim" },
    { name: "Noor Haddad", login: "noorh" },
    { name: "Tom Becker", login: "tbecker" },
    { name: "Ines Duarte", login: "inesd" },
    { name: "Kwame Mensah", login: "kmensah" },
    { name: "Lena Vogel", login: "lvogel" },
    { name: "Ola Nordmann", login: "olan" },
  ].slice(0, n);

const canvasNames = [
  "Kettle onboarding",
  "Pricing page",
  "Settings refresh",
  "Empty states",
  "Search results",
  "Billing banner",
  "Invite flow",
  "Mobile nav",
  "Changelog",
  "Docs home",
  "Status page",
];
const canvases = (n: number, workspaces = ["Northbrook"]): RecapCanvas[] =>
  canvasNames.slice(0, n).map((name, i) => ({
    name,
    href: canvas(`cnv_${i + 1}`, "pull-request"),
    workspaceName: workspaces[i % workspaces.length]!,
    numbers: i === 0 && n > 1 ? [41, 44] : [41 + i * 3],
    weekday: ["Tuesday", "Wednesday", "Thursday", "Monday"][i % 4]!,
  }));

const recap = (list: RecapCanvas[], extra: Partial<EmailProps["recap"]> = {}) => ({
  date: "Friday, November 13",
  canvases: list,
  first: false,
  countsOnly: false,
  unsubscribeUrl: unsubscribe("recap"),
  ...extra,
});

const line = (text: string, id = "cnv_1") => ({ text, href: canvas(id) });
const digestGroups: Record<string, DigestGroup[]> = {
  one: [
    {
      name: "Kettle onboarding",
      billing: false,
      lines: [line("Ponzu has a question for you.")],
      more: 0,
    },
  ],
  several: [
    {
      name: "Kettle onboarding",
      billing: false,
      lines: [
        line("Ponzu finished what you asked."),
        line("Maya and Sam left 3 comments."),
        line("Pull request #41 is ready to merge."),
      ],
      more: 0,
    },
  ],
  two: [
    {
      name: "Kettle onboarding",
      billing: false,
      lines: [line("Ponzu has a question for you."), line("Pull request #41 is ready to merge.")],
      more: 0,
    },
    {
      name: "Northbrook",
      billing: true,
      lines: [{ text: "Northbrook has used 80% of this month's $100 cap.", href: null }],
      more: 0,
    },
  ],
  many: [
    {
      name: HOSTILE.long,
      billing: false,
      lines: Array.from({ length: 10 }, (_, i) =>
        line(`Pull request #${i + 1} is ready to merge.`),
      ),
      more: 3,
    },
    {
      name: HOSTILE.markup,
      billing: false,
      lines: [line("Ponzu replied to your comment.", "cnv_2")],
      more: 0,
    },
    {
      name: HOSTILE.rtl,
      billing: false,
      lines: [line("Ponzu finished what you asked.", "cnv_3")],
      more: 0,
    },
    { name: HOSTILE.emoji, billing: false, lines: [line("Maya commented.", "cnv_4")], more: 0 },
  ],
  billingAlone: [
    {
      name: "Northbrook",
      billing: true,
      lines: [{ text: "Northbrook's payment of $123.40 didn't go through.", href: null }],
      more: 0,
    },
  ],
};

type Fixture = { [K in EmailKind]: { kind: K; props: EmailProps[K] } }[EmailKind];
const fixture = <K extends EmailKind>(kind: K, props: EmailProps[K]) =>
  ({ kind, props }) as Fixture;

const reason1000 = `${HOSTILE.script} `.padEnd(1000, "x");

export const FIXTURES: Record<string, Fixture> = {
  // Billing (§1.1 to §1.4)
  "billing-free-used": fixture(
    "billing",
    billing({
      ...org,
      notice: "free_used",
      headline: "Northbrook has used this month's free credits.",
      periodEnd: "December 8 at 7 pm",
      price: "$0.10",
      settingsUrl: settings,
    }),
  ),
  "billing-free-used-personal": fixture(
    "billing",
    billing({
      ...personal,
      notice: "free_used",
      headline: "You've used this month's free credits.",
      periodEnd: "December 9",
      price: "$0.10",
      settingsUrl: settings,
    }),
  ),
  "billing-cap-warning": fixture(
    "billing",
    billing({
      ...org,
      notice: "cap_warning",
      headline: "Northbrook has used 80% of this month's $100 cap.",
      periodEnd: "December 9",
      cap: "$100",
      percent: 80,
      settingsUrl: settings,
    }),
  ),
  "billing-cap-warning-personal": fixture(
    "billing",
    billing({
      ...personal,
      notice: "cap_warning",
      headline: "You've used 80% of this month's $100 cap.",
      periodEnd: "December 9",
      cap: "$100",
      percent: 80,
      settingsUrl: settings,
    }),
  ),
  "billing-cap-reached": fixture(
    "billing",
    billing({
      ...org,
      notice: "cap_reached",
      headline: "Northbrook reached this month's $100 cap.",
      periodEnd: "December 9",
      settingsUrl: settings,
    }),
  ),
  "billing-cap-reached-personal": fixture(
    "billing",
    billing({
      ...personal,
      notice: "cap_reached",
      headline: "You've reached this month's $100 cap.",
      periodEnd: "December 9",
      settingsUrl: settings,
    }),
  ),
  "billing-payment-failed": fixture(
    "billing",
    billing({
      ...org,
      notice: "payment_failed",
      headline: "Northbrook's payment of $123.40 didn't go through.",
      reason: "failed",
      graceEnd: "December 15 at 9 pm",
      invoiceUrl: invoice,
      settingsUrl: settings,
    }),
  ),
  "billing-payment-failed-personal": fixture(
    "billing",
    billing({
      ...personal,
      notice: "payment_failed",
      headline: "Your payment of $123.40 didn't go through.",
      reason: "failed",
      graceEnd: "December 15 at 9 pm",
      invoiceUrl: invoice,
      settingsUrl: settings,
    }),
  ),
  "billing-payment-needs-confirmation": fixture(
    "billing",
    billing({
      ...org,
      notice: "payment_failed",
      headline: "Northbrook's payment of $123.40 didn't go through.",
      reason: "needs_confirmation",
      graceEnd: "December 15 at 9 pm",
      invoiceUrl: invoice,
      settingsUrl: settings,
    }),
  ),
  "billing-payment-no-invoice": fixture(
    "billing",
    billing({
      ...org,
      notice: "payment_failed",
      headline: "Northbrook's payment of $123.40 didn't go through.",
      reason: "failed",
      graceEnd: "December 15 at 9 pm",
      invoiceUrl: null,
      settingsUrl: settings,
    }),
  ),
  "billing-payment-foreign-invoice": fixture(
    "billing",
    billing({
      ...org,
      notice: "payment_failed",
      headline: "Northbrook's payment of $123.40 didn't go through.",
      reason: "failed",
      graceEnd: "December 15 at 9 pm",
      invoiceUrl: "https://invoice.stripe.com.evil.example/i/x",
      settingsUrl: settings,
    }),
  ),

  // People joined (§1.5)
  ...Object.fromEntries(
    [1, 2, 3, 4, 12].map((n) => [
      `team-${n}`,
      fixture("team", {
        workspaceName: "Northbrook",
        people: people(n),
        total: n + 2,
        unsubscribeUrl: unsubscribe("team"),
      }),
    ]),
  ),
  "team-hostile": fixture("team", {
    workspaceName: HOSTILE.markup,
    people: [
      { name: HOSTILE.script, login: "attacker" },
      { name: HOSTILE.rtl, login: "rtl-person" },
    ],
    total: 1,
    unsubscribeUrl: unsubscribe("team"),
  }),

  // The Friday recap (§1.6)
  "recap-1": fixture("recap", recap(canvases(1))),
  "recap-2": fixture("recap", recap(canvases(2))),
  "recap-3": fixture("recap", recap(canvases(3))),
  "recap-11": fixture("recap", recap(canvases(11, ["Northbrook", "Kettle Labs"]))),
  "recap-first": fixture("recap", recap(canvases(1), { first: true })),
  "recap-counts-only": fixture("recap", recap(canvases(2), { countsOnly: true })),
  "recap-hostile": fixture(
    "recap",
    recap(
      [HOSTILE.long, HOSTILE.markup, HOSTILE.rtl, HOSTILE.emoji].map((name, i) => ({
        name,
        href: canvas(`cnv_${i + 1}`, "pull-request"),
        workspaceName: "Northbrook",
        numbers: [7 + i],
        weekday: "Thursday",
      })),
    ),
  ),

  // The daily digest (§1.7)
  "digest-one": fixture("digest", {
    groups: digestGroups.one!,
    unsubscribeUrl: unsubscribe("digest"),
  }),
  "digest-several": fixture("digest", {
    groups: digestGroups.several!,
    unsubscribeUrl: unsubscribe("digest"),
  }),
  "digest-two": fixture("digest", {
    groups: digestGroups.two!,
    unsubscribeUrl: unsubscribe("digest"),
  }),
  "digest-many": fixture("digest", {
    groups: digestGroups.many!,
    unsubscribeUrl: unsubscribe("digest"),
  }),
  "digest-billing": fixture("digest", {
    groups: digestGroups.billingAlone!,
    unsubscribeUrl: unsubscribe("digest"),
  }),

  // Legal notices (§1.8)
  "notice-billing-starts": fixture("notice", {
    notice: "billing_starts",
    effective: "February 1",
    free: "100 free credits for each member",
    price: "$0.10",
    cap: "$100",
    replyTo: true,
  }),
  "notice-price-rise": fixture("notice", {
    notice: "price_rise",
    effective: "March 1",
    oldPrice: "$0.10",
    newPrice: "$0.12",
    replyTo: true,
  }),
  "notice-terms-change": fixture("notice", {
    notice: "terms_change",
    effective: "February 1",
    summary: [
      "The terms now say how long Ponzu keeps a canvas after its workspace is deleted.",
      "Nothing else changes.",
    ],
    replyTo: true,
  }),
  "notice-privacy-change": fixture("notice", {
    notice: "privacy_change",
    effective: "February 1",
    summary: ["Ponzu will use your email address to send a Friday recap of what you shipped."],
    replyTo: true,
  }),
  "notice-shutdown": fixture("notice", {
    notice: "shutdown",
    effective: "June 30",
    summary: [],
    replyTo: true,
  }),
  "notice-suspension": fixture("notice", {
    notice: "suspension",
    workspaceName: null,
    reason: reason1000,
    replyTo: true,
  }),
  "notice-suspension-workspace": fixture("notice", {
    notice: "suspension",
    workspaceName: "Northbrook",
    reason: "Payments for this workspace were reported as fraudulent.",
    replyTo: false,
  }),
};

export type FixtureName = keyof typeof FIXTURES;
