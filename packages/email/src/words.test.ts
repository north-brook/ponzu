import { describe, expect, test } from "bun:test";
import { subjectOf as digestSubject } from "./templates/digest.tsx";
import { clip, nameOf, oneLine } from "./text.ts";
import {
  billingWords,
  digestWords,
  firstNameOf,
  membersWords,
  noticeWords,
  recapWords,
  unsubscribeWords,
} from "./words.ts";

/*
 * The sentences designs/email.md §1 and §3.7 settle, pinned exactly. The expected/ files pin
 * each whole email; these pin the rules that build subjects from names and numbers.
 */

const org = { workspaceName: "Northbrook", personal: false };
const personal = { workspaceName: "maya", personal: true };

describe("billing", () => {
  test("free credits used", () => {
    expect(billingWords.freeUsed.preview(org, "December 9")).toBe(
      "New work waits until an admin adds a card. Free credits come back on December 9.",
    );
    expect(billingWords.freeUsed.preview(personal, "December 9")).toBe(
      "New work waits until you add a card. Free credits come back on December 9.",
    );
    expect(billingWords.freeUsed.first(org, "December 9")).toBe(
      "No new work starts on Northbrook's canvases until an admin adds a card, or until the free credits come back on December 9. Work already running finishes.",
    );
    expect(billingWords.freeUsed.second(org, "$0.10")).toBe(
      "With a card, credits past the free ones cost $0.10 each, up to a monthly cap that admins set.",
    );
    expect(billingWords.freeUsed.second(personal, "$0.10")).toBe(
      "With a card, credits past the free ones cost $0.10 each, up to a monthly cap that you set.",
    );
  });

  test("the cap", () => {
    expect(billingWords.capWarning.preview("$100", "December 9")).toBe(
      "Nothing waits yet. At $100, new work waits until the cap is raised or it resets on December 9.",
    );
    expect(billingWords.capReached.first(personal, "December 9")).toBe(
      "No new work starts on your canvases until you raise the cap, or until it resets on December 9. Work already running finishes, and Ponzu never bills past the cap.",
    );
  });

  test("a payment that didn't go through", () => {
    const words = billingWords.paymentFailed;
    expect(words.failed(org, "December 15 at 9 pm")).toBe(
      "Canvases in Northbrook keep working until December 15 at 9 pm. If the invoice is still unpaid then, no new work starts until it's paid.",
    );
    expect(words.needsConfirmation(personal, "December 15 at 9 pm")).toBe(
      "The bank asked for this payment to be confirmed, and it hasn't been yet. Your canvases keep working until December 15 at 9 pm. If it's still unconfirmed then, no new work starts until it's paid.",
    );
    expect([words.pay, words.open, words.fallback, words.changeCard]).toEqual([
      "Pay the invoice",
      "Open the invoice",
      "Open Plan and usage",
      "Change the card",
    ]);
  });

  test("the footer says why, and that it can't be turned off", () => {
    expect(billingWords.footer(org)).toBe(
      "You get this because you're an admin of Northbrook on Ponzu. Billing emails go to every admin and can't be turned off.",
    );
    expect(billingWords.footer(personal)).toBe(
      "You get this because Ponzu bills your personal workspace. Billing emails can't be turned off.",
    );
  });
});

describe("people joined", () => {
  const maya = { name: "Maya Chen", login: "mayachen" };
  const sam = { name: "Sam Okafor", login: "sokafor" };
  const lee = { name: null, login: "lee" };
  const ana = { name: "  ", login: "ana" };

  test("first names follow the pings' rule: the name to its first space, else @login", () => {
    expect([maya, lee, ana].map(firstNameOf)).toEqual(["Maya", "@lee", "@ana"]);
  });

  test("the subject names one, two, three, or two and the rest", () => {
    expect(membersWords.subject("Northbrook", [maya])).toBe("Maya joined Northbrook on Ponzu");
    expect(membersWords.subject("Northbrook", [maya, sam])).toBe(
      "Maya and Sam joined Northbrook on Ponzu",
    );
    expect(membersWords.subject("Northbrook", [maya, sam, lee])).toBe(
      "Maya, Sam and @lee joined Northbrook on Ponzu",
    );
    expect(membersWords.subject("Northbrook", [maya, sam, lee, ana, maya])).toBe(
      "Maya, Sam and 3 others joined Northbrook on Ponzu",
    );
  });

  test("the count says person or people", () => {
    expect(membersWords.total("Northbrook", 1)).toBe("Northbrook now has 1 person on Ponzu.");
    expect(membersWords.total("Northbrook", 6)).toBe("Northbrook now has 6 people on Ponzu.");
  });
});

describe("the Friday recap", () => {
  test("names come before numbers, newest merge first", () => {
    expect(recapWords.subject(["Kettle onboarding"])).toBe("Shipped this week: Kettle onboarding");
    expect(recapWords.subject(["Kettle onboarding", "Pricing page"])).toBe(
      "Shipped this week: Kettle onboarding and Pricing page",
    );
    expect(recapWords.subject(["Kettle onboarding", "Pricing page", "Docs"])).toBe(
      "Shipped this week: Kettle onboarding and 2 more",
    );
  });

  test("the counts-only form", () => {
    expect(recapWords.countsSubject(1, 1)).toBe(
      "Shipped this week: 1 canvas, 1 pull request merged",
    );
    expect(recapWords.countsSubject(2, 3)).toBe(
      "Shipped this week: 2 canvases, 3 pull requests merged",
    );
  });

  test("the preview and the lines under each canvas", () => {
    expect(recapWords.previewOne(41, "Tuesday")).toBe("Pull request #41 was merged on Tuesday.");
    expect(recapWords.previewMany(4)).toBe(
      "4 pull requests from your canvases were merged this week.",
    );
    expect(`${recapWords.numbers([41])} ${recapWords.merged(1, "Tuesday")}`).toBe(
      "#41 merged Tuesday",
    );
    expect(`${recapWords.numbers([41, 44])} ${recapWords.merged(2, "Tuesday")}`).toBe(
      "#41 and #44 merged this week",
    );
    expect(recapWords.moreCanvases(2)).toBe("And 2 more canvases.");
    expect(recapWords.closing).toBe("Have a good weekend.");
    // Not "one click": the footer link opens a page with one button (designs/email.md §3.7).
    expect(recapWords.first).toBe(
      "This is your first Friday recap. It comes only in weeks when a pull request from a canvas you own is merged. The link below turns it off.",
    );
  });
});

describe("the daily digest", () => {
  const line = (text: string) => ({ text, href: null });
  const group = (name: string, n: number, billing = false) => ({
    name,
    billing,
    lines: Array.from({ length: n }, (_, i) => line(`Line ${i}.`)),
    more: 0,
  });
  const subject = (...groups: ReturnType<typeof group>[]) =>
    digestSubject({ groups, unsubscribeUrl: "https://api.ponzu.design/x" });

  test("its subject is canvas-first, without the old Ponzu: prefix", () => {
    expect(
      digestSubject({
        groups: [
          {
            name: "Kettle onboarding",
            billing: false,
            lines: [line("Ponzu has a question for you.")],
            more: 0,
          },
        ],
        unsubscribeUrl: "https://api.ponzu.design/x",
      }),
    ).toBe("Kettle onboarding: Ponzu has a question for you");
    expect(subject(group("Kettle onboarding", 3))).toBe(
      "Kettle onboarding: 3 things since yesterday",
    );
    expect(subject(group("Kettle onboarding", 3), group("Pricing page", 2))).toBe(
      "Kettle onboarding and Pricing page: 5 things since yesterday",
    );
    expect(subject(group("Kettle onboarding", 3), group("Pricing page", 2), group("Docs", 2))).toBe(
      "Kettle onboarding and 2 more canvases: 7 things since yesterday",
    );
    // A workspace's plan among the groups left unnamed is not counted as a canvas.
    expect(
      subject(group("Kettle onboarding", 3), group("Northbrook", 1, true), group("Docs", 2)),
    ).toBe("Kettle onboarding and 2 more: 6 things since yesterday");
    expect(
      subject(
        group("Kettle onboarding", 3),
        group("Pricing page", 2),
        group("Docs", 1),
        group("Empty states", 1),
      ),
    ).toBe("Kettle onboarding and 3 more canvases: 7 things since yesterday");
    expect(subject(group("Northbrook", 2, true))).toBe(
      "Northbrook's plan: 2 things since yesterday",
    );
    expect(
      digestSubject({
        groups: [
          {
            name: "Northbrook",
            billing: true,
            lines: [line("Northbrook reached this month's $100 cap.")],
            more: 0,
          },
        ],
        unsubscribeUrl: "https://api.ponzu.design/x",
      }),
    ).toBe("Northbrook reached this month's $100 cap");
  });

  test("its fixed words", () => {
    expect(digestWords.intro).toBe("Here is what Ponzu told you about in the last day.");
    expect(digestWords.footer).toBe(
      "You get this email once a day because it is on in Ponzu's Settings.",
    );
    expect(digestWords.stop).toBe("Stop these emails");
  });
});

describe("legal notices", () => {
  test("the subjects carry the effective day", () => {
    const s = noticeWords.subject;
    expect(s.billing_starts("February 1")).toBe("Billing on Ponzu starts on February 1");
    expect(s.price_rise("March 1")).toBe("Ponzu's price per credit changes on March 1");
    expect(s.terms_change("February 1")).toBe("Ponzu's terms change on February 1");
    expect(s.privacy_change("February 1")).toBe("Ponzu's privacy policy changes on February 1");
    expect(s.shutdown("June 30")).toBe("Ponzu is closing on June 30");
    expect(s.suspension(null)).toBe("Your Ponzu account is suspended");
  });

  test("the footer", () => {
    expect(noticeWords.footer).toBe(
      "You get this because Ponzu's terms promise it by email. It can't be turned off.",
    );
  });
});

describe("the unsubscribe page", () => {
  test("asks, then says what stopped", () => {
    expect(unsubscribeWords.question).toEqual({
      digest: "Stop Ponzu's daily email?",
      team: "Stop emails when people join?",
      recap: "Stop Ponzu's Friday recap?",
    });
    expect(unsubscribeWords.done).toEqual({
      digest: "You won't get Ponzu's daily email any more.",
      team: "You won't get an email when people join a workspace any more.",
      recap: "You won't get Ponzu's Friday recap any more.",
    });
    expect(unsubscribeWords.backOn).toBe("Turn it back on in Ponzu, in Settings › Notifications.");
  });
});

describe("names", () => {
  test("lose controls and bidirectional overrides, and clip on grapheme boundaries", () => {
    expect(oneLine("a\nb‮c\t d")).toBe("a b c d");
    // Each of these is four code points; a cut never leaves part of one.
    expect(clip("👩🏽‍💻👩🏽‍💻👩🏽‍💻", 6)).toBe("👩🏽‍💻…");
    expect(clip("תכנון השקה של קומקום", 8)).toBe("תכנון ה…");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(nameOf("   ")).toBe("Untitled");
    expect(nameOf("x".repeat(90), 40)).toBe(`${"x".repeat(39)}…`);
  });
});
