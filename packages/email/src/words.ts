/*
 * Every fixed sentence an email says (designs/email.md §1, §3.7 and §4), as pure functions, so
 * the words are reviewed as text and words.test.ts pins each one. Names come in raw and are made
 * safe here (text.ts); money, dates and a ping's sentence come in finished, from the API, so an
 * email cannot disagree with its ping.
 *
 * The voice: Ponzu speaks, never Claude. Plain full sentences, sentence case, no exclamation
 * marks, no emoji, no greeting, no "we", nothing promotional.
 */
import { COMPANY_LINE, HELLO_ADDRESS } from "./brand.ts";
import { clip, count, listOf, nameOf, oneLine, SUBJECT_NAME_MAX } from "./text.ts";

/** The longest suspension reason a notice carries: the founder's own words, escaped. */
export const SUSPENSION_REASON_MAX = 1000;

/** At most this many entries in a list (people, canvases, a digest group's lines). */
export const LIST_MAX = 10;

export const words = {
  entity: COMPANY_LINE,
  replyLine: "Questions? Reply to this email.",
  andMore: (n: number) => `And ${n.toLocaleString("en-US")} more.`,
};

// ---------------------------------------------------------------------------------------------
// Billing (§1.1 to §1.4)

export type BillingNotice = "free_used" | "cap_warning" | "cap_reached" | "payment_failed";

/** Who a billing email speaks to: an organisation's admins, or a personal workspace's person. */
export interface BillingWho {
  workspaceName: string;
  personal: boolean;
}

const theirCanvases = (who: BillingWho) =>
  who.personal ? "your canvases" : `${nameOf(who.workspaceName)}'s canvases`;

export const billingWords = {
  freeUsed: {
    preview: (who: BillingWho, periodEnd: string) =>
      who.personal
        ? `New work waits until you add a card. Free credits come back on ${periodEnd}.`
        : `New work waits until an admin adds a card. Free credits come back on ${periodEnd}.`,
    first: (who: BillingWho, periodEnd: string) =>
      who.personal
        ? `No new work starts on your canvases until you add a card, or until the free credits come back on ${periodEnd}. Work already running finishes.`
        : `No new work starts on ${theirCanvases(who)} until an admin adds a card, or until the free credits come back on ${periodEnd}. Work already running finishes.`,
    second: (who: BillingWho, price: string) =>
      `With a card, credits past the free ones cost ${price} each, up to a monthly cap that ${who.personal ? "you set" : "admins set"}.`,
    action: "Add a card",
  },
  capWarning: {
    preview: (cap: string, periodEnd: string) =>
      `Nothing waits yet. At ${cap}, new work waits until the cap is raised or it resets on ${periodEnd}.`,
    first: (who: BillingWho, cap: string, periodEnd: string) =>
      who.personal
        ? `Nothing waits yet. At ${cap}, no new work starts on your canvases until you raise the cap, or until it resets on ${periodEnd}.`
        : `Nothing waits yet. At ${cap}, no new work starts on ${theirCanvases(who)} until an admin raises the cap, or until it resets on ${periodEnd}.`,
    action: "Review the cap",
  },
  capReached: {
    preview: (periodEnd: string) =>
      `New work waits until the cap is raised or it resets on ${periodEnd}.`,
    first: (who: BillingWho, periodEnd: string) =>
      who.personal
        ? `No new work starts on your canvases until you raise the cap, or until it resets on ${periodEnd}. Work already running finishes, and Ponzu never bills past the cap.`
        : `No new work starts on ${theirCanvases(who)} until an admin raises the cap, or until it resets on ${periodEnd}. Work already running finishes, and Ponzu never bills past the cap.`,
    action: "Raise the cap",
  },
  paymentFailed: {
    preview: (graceEnd: string) => `Canvases keep working until ${graceEnd}.`,
    keepWorking: (who: BillingWho, graceEnd: string) =>
      who.personal
        ? `Your canvases keep working until ${graceEnd}.`
        : `Canvases in ${nameOf(who.workspaceName)} keep working until ${graceEnd}.`,
    failed: (who: BillingWho, graceEnd: string) =>
      `${billingWords.paymentFailed.keepWorking(who, graceEnd)} If the invoice is still unpaid then, no new work starts until it's paid.`,
    needsConfirmation: (who: BillingWho, graceEnd: string) =>
      `The bank asked for this payment to be confirmed, and it hasn't been yet. ${billingWords.paymentFailed.keepWorking(who, graceEnd)} If it's still unconfirmed then, no new work starts until it's paid.`,
    payOrChange: (who: BillingWho) =>
      who.personal
        ? "You can pay it on Stripe's invoice page, or change the card in Plan and usage."
        : "Any admin can pay it on Stripe's invoice page, or change the card in Plan and usage.",
    changeOnly: (who: BillingWho) =>
      who.personal
        ? "You can change the card in Plan and usage."
        : "Any admin can change the card in Plan and usage.",
    pay: "Pay the invoice",
    open: "Open the invoice",
    fallback: "Open Plan and usage",
    changeCard: "Change the card",
  },
  footer: (who: BillingWho) =>
    who.personal
      ? "You get this because Ponzu bills your personal workspace. Billing emails can't be turned off."
      : `You get this because you're an admin of ${nameOf(who.workspaceName)} on Ponzu. Billing emails go to every admin and can't be turned off.`,
};

// ---------------------------------------------------------------------------------------------
// People joined (§1.5)

/** Someone who joined, as an admin may see them. */
export interface Person {
  /** `users.name`, whatever they or their sign-in gave. */
  name: string | null;
  /** Their GitHub login, without the @. */
  login: string;
}

/** The most of a person a subject says: their name up to its first space, else `@login`. */
export function firstNameOf(person: Person): string {
  const first = oneLine(person.name ?? "").split(" ")[0] ?? "";
  if (first) return clip(first, FIRST_NAME_MAX);
  return clip(`@${oneLine(person.login)}`, FIRST_NAME_MAX);
}

/** The most characters of a first name a subject carries, as a ping's (copy.ts). */
export const FIRST_NAME_MAX = 32;

export const membersWords = {
  subject: (workspaceName: string, people: readonly Person[]) => {
    const names = people.map(firstNameOf);
    const who =
      names.length <= 3 ? listOf(names) : `${names[0]}, ${names[1]} and ${names.length - 2} others`;
    return `${who} joined ${nameOf(workspaceName, SUBJECT_NAME_MAX)} on Ponzu`;
  },
  total: (workspaceName: string, total: number) =>
    `${nameOf(workspaceName)} now has ${count(total, "person", "people")} on Ponzu.`,
  paragraph: (workspaceName: string, total: number) =>
    `${membersWords.total(workspaceName, total)} Who can use it follows GitHub: each person sees the canvases of the repositories GitHub lets them read.`,
  footer: (workspaceName: string) =>
    `You get this because you're an admin of ${nameOf(workspaceName)} on Ponzu.`,
  stop: "Stop emails when people join",
};

// ---------------------------------------------------------------------------------------------
// The Friday recap (§1.6, §5)

export const recapWords = {
  title: "Shipped this week",
  lede: "Merged since last Friday, from canvases you own.",
  subject: (names: readonly string[]) => {
    const clipped = names.map((name) => nameOf(name, SUBJECT_NAME_MAX));
    const what =
      clipped.length <= 2
        ? listOf(clipped)
        : `${clipped[0]} and ${(clipped.length - 1).toLocaleString("en-US")} more`;
    return `Shipped this week: ${what}`;
  },
  countsSubject: (canvases: number, pullRequests: number) =>
    `Shipped this week: ${count(canvases, "canvas", "canvases")}, ${count(pullRequests, "pull request", "pull requests")} merged`,
  countsParagraph: (canvases: number, pullRequests: number) =>
    pullRequests === 1
      ? "1 pull request from a canvas you own was merged."
      : `${pullRequests.toLocaleString("en-US")} pull requests from ${canvases === 1 ? "a canvas" : `${count(canvases, "canvas", "canvases")}`} you own were merged.`,
  previewOne: (number: number, weekday: string) =>
    `Pull request #${number} was merged on ${weekday}.`,
  previewMany: (pullRequests: number) =>
    `${pullRequests.toLocaleString("en-US")} pull requests from your canvases were merged this week.`,
  /** "merged Tuesday" after one number, "merged this week" after several. */
  merged: (pullRequests: number, weekday: string) =>
    pullRequests === 1 ? `merged ${weekday}` : "merged this week",
  numbers: (numbers: readonly number[]) => listOf(numbers.map((n) => `#${n}`)),
  moreCanvases: (n: number) => `And ${count(n, "more canvas", "more canvases")}.`,
  first:
    "This is your first Friday recap. It comes only in weeks when a pull request from a canvas you own is merged. The link below turns it off.",
  closing: "Have a good weekend.",
  footer: "You get this on Fridays when a pull request from a canvas you own was merged.",
  stop: "Stop Friday emails",
};

// ---------------------------------------------------------------------------------------------
// The daily digest (§1.7)

export const digestWords = {
  title: "Since yesterday",
  intro: "Here is what Ponzu told you about in the last day.",
  /** A billing group's name. */
  plan: (workspaceName: string) => `${nameOf(workspaceName, SUBJECT_NAME_MAX)}'s plan`,
  things: (n: number) => `${count(n, "thing", "things")} since yesterday`,
  /**
   * The groups a subject does not name: "2 more canvases", or just "2 more" when a workspace's
   * plan is among them, so a plan is never counted as a canvas.
   */
  more: (n: number, allCanvases: boolean) =>
    allCanvases
      ? `${count(n, "more canvas", "more canvases")}`
      : `${n.toLocaleString("en-US")} more`,
  footer: "You get this email once a day because it is on in Ponzu's Settings.",
  stop: "Stop these emails",
};

// ---------------------------------------------------------------------------------------------
// Legal notices (§1.8)

export type NoticeKind =
  | "billing_starts"
  | "price_rise"
  | "terms_change"
  | "privacy_change"
  | "shutdown"
  | "suspension";

export const noticeWords = {
  subject: {
    billing_starts: (date: string) => `Billing on Ponzu starts on ${date}`,
    price_rise: (date: string) => `Ponzu's price per credit changes on ${date}`,
    terms_change: (date: string) => `Ponzu's terms change on ${date}`,
    privacy_change: (date: string) => `Ponzu's privacy policy changes on ${date}`,
    shutdown: (date: string) => `Ponzu is closing on ${date}`,
    suspension: (workspaceName: string | null) =>
      workspaceName === null
        ? "Your Ponzu account is suspended"
        : `${nameOf(workspaceName, SUBJECT_NAME_MAX)} is suspended on Ponzu`,
  },
  billingStarts: {
    first: "Until then, Ponzu stays free, and nothing is charged until an admin adds a card.",
    prices: (free: string, price: string, cap: string) =>
      `From then, each workspace gets ${free} each month. Past those, credits cost ${price} each and need a card, which an admin adds. Each workspace has a monthly cap, ${cap} unless an admin changes it, and Ponzu never bills past it.`,
    action: "See the pricing",
  },
  priceRise: {
    first: (date: string, oldPrice: string, newPrice: string) =>
      `From ${date}, a credit on Ponzu costs ${newPrice} instead of ${oldPrice}.`,
    when: (date: string) =>
      `The new price applies from each workspace's first month that starts on or after ${date}. Credits used before then cost what they did.`,
    action: "See the pricing",
  },
  termsChange: {
    action: "Read the new terms",
    history: "See what changed on GitHub",
  },
  privacyChange: {
    action: "Read the new policy",
    history: "See what changed on GitHub",
  },
  shutdown: {
    first: "Until then, everything keeps working.",
    takeOut: (date: string) =>
      `Your code is already on GitHub, in the pull requests Ponzu opened. Until ${date}, boards can be exported as PNG or PDF from the app.`,
  },
  suspension: {
    first: (workspaceName: string | null) =>
      workspaceName === null
        ? "You can't use Ponzu while your account is suspended."
        : `No one can use ${nameOf(workspaceName)} on Ponzu while it is suspended.`,
    reasonLead: "The reason:",
    appeal: `If you think this is a mistake, write to ${HELLO_ADDRESS} and a person will look again.`,
  },
  footer: "You get this because Ponzu's terms promise it by email. It can't be turned off.",
};

// ---------------------------------------------------------------------------------------------
// The unsubscribe page (§3.7), answered by the API

export type UnsubscribeCategory = "digest" | "team" | "recap";

export const unsubscribeWords = {
  question: {
    digest: "Stop Ponzu's daily email?",
    team: "Stop emails when people join?",
    recap: "Stop Ponzu's Friday recap?",
  } satisfies Record<UnsubscribeCategory, string>,
  button: "Stop these emails",
  done: {
    digest: "You won't get Ponzu's daily email any more.",
    team: "You won't get an email when people join a workspace any more.",
    recap: "You won't get Ponzu's Friday recap any more.",
  } satisfies Record<UnsubscribeCategory, string>,
  backOn: "Turn it back on in Ponzu, in Settings › Notifications.",
};
