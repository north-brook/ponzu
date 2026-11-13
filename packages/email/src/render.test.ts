import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { API_URL, FIXTURES, HOSTILE } from "./fixtures.ts";
import { renderEmail } from "./render.ts";

/*
 * Every fixture's words are checked in as text (expected/<name>.txt: subject, preview and the
 * text part), so a change to what an email says is reviewed in the diff. After changing words
 * on purpose: PONZU_UPDATE_EXPECTED=1 bun test packages/email, then read the diff.
 */
const EXPECTED = resolve(import.meta.dir, "../expected");
const update = process.env.PONZU_UPDATE_EXPECTED === "1";

/** The hosts an email may link to (the email plan §7). GitHub only for a legal page's history. */
const HOSTS = new Set(["ponzu.design", new URL(API_URL).host, "invoice.stripe.com", "github.com"]);

const decode = (text: string) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

/** Text as React writes it into HTML. */
const asHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

const hrefsOf = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => decode(m[1]!));

const rendered = new Map(
  await Promise.all(
    Object.entries(FIXTURES).map(
      async ([name, { kind, props }]) => [name, await renderEmail(kind, props as never)] as const,
    ),
  ),
);

describe("every fixture", () => {
  if (update) mkdirSync(EXPECTED, { recursive: true });

  for (const [name, email] of rendered) {
    test(`${name}: the exact subject, preview and text part`, () => {
      const words = `Subject: ${email.subject}\nPreview: ${email.preview}\n\n${email.text}`;
      const file = join(EXPECTED, `${name}.txt`);
      if (update) writeFileSync(file, words);
      expect(words).toBe(readFileSync(file, "utf8"));
    });

    test(`${name}: HTML that every mail app can take`, () => {
      const { html, text } = email;
      expect(new TextEncoder().encode(html).byteLength).toBeLessThan(60 * 1024);
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("javascript:");
      expect(html).not.toMatch(/\s(href|src)="http:/);
      // At most one action.
      expect(html.match(/data-action="true"/g)?.length ?? 0).toBeLessThanOrEqual(1);
      // Every picture is absolute https, with its size and words.
      for (const [img] of html.matchAll(/<img[^>]*>/g)) {
        expect(img).toMatch(/\ssrc="https:\/\//);
        expect(img).toMatch(/\swidth="\d+"/);
        expect(img).toMatch(/\sheight="\d+"/);
        expect(img).toMatch(/\salt="[^"]+"/);
      }
      // Every link goes to a known host, and the text part carries it too.
      for (const href of hrefsOf(html)) {
        const url = new URL(href);
        expect(url.protocol).toBe("https:");
        expect(HOSTS.has(url.host)).toBe(true);
        expect(text).toContain(href);
      }
      // The footer always names who sends it.
      expect(text).toContain("Northbrook PBC, 169 Madison Ave, Suite 2504, New York, NY 10016");
      // Preview text, as the mail app shows it beside the subject.
      expect(html).toContain(asHtml(email.preview));
    });
  }

  test("no expected file is left without its fixture", () => {
    if (update || !existsSync(EXPECTED)) return;
    const names = readdirSync(EXPECTED).map((file) => file.replace(/\.txt$/, ""));
    expect(names.sort()).toEqual([...rendered.keys()].sort());
  });
});

describe("rendering", () => {
  test("is deterministic: the same props give the same bytes", async () => {
    for (const [name, { kind, props }] of Object.entries(FIXTURES)) {
      const again = await renderEmail(kind, props as never);
      expect(again).toEqual(rendered.get(name)!);
    }
  });

  test("escapes a hostile name in the HTML and keeps it verbatim in the text", () => {
    const digest = rendered.get("digest-many")!;
    expect(digest.html).toContain("&lt;b&gt;Q4 &amp; &quot;launch&quot;&lt;/b&gt;");
    expect(digest.html).not.toContain(HOSTILE.markup);
    expect(digest.text).toContain(HOSTILE.markup);

    const team = rendered.get("team-hostile")!;
    expect(team.html).not.toContain("<script>");
    expect(team.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    // A subject is plain text: Resend sends it as a header, never as HTML.
    expect(team.subject).toBe(
      '<script>alert("x")</script> and תכנון joined <b>Q4 & "launch"</b> on Ponzu',
    );
  });

  test("clips long names in subjects at 40 characters, on grapheme boundaries", () => {
    expect(rendered.get("digest-many")!.subject).toBe(
      "Kettle onboarding flow for the new self… and 3 more canvases: 16 things since yesterday",
    );
    const recap = rendered.get("recap-hostile")!;
    expect(recap.subject).toBe(
      "Shipped this week: Kettle onboarding flow for the new self… and 3 more",
    );
    expect(recap.text).toContain(HOSTILE.rtl);
    expect(recap.text).toContain(HOSTILE.emoji);
    expect(recap.html).toContain('dir="auto"');
  });

  test("escapes a suspension reason, and refuses one past 1,000 characters", async () => {
    const notice = rendered.get("notice-suspension")!;
    expect(notice.html).not.toContain("<script>");
    expect(notice.html).toContain("&lt;script&gt;");
    expect(notice.text).toContain('<script>alert("x")</script>');
    await expect(
      renderEmail("notice", {
        notice: "suspension",
        workspaceName: null,
        reason: "x".repeat(1001),
        replyTo: false,
      }),
    ).rejects.toThrow("at most 1000 characters");
  });

  test("the counts-only recap names no canvas anywhere", () => {
    const email = rendered.get("recap-counts-only")!;
    for (const part of [email.subject, email.preview, email.html, email.text]) {
      expect(part).not.toContain("Kettle onboarding");
      expect(part).not.toContain("Pricing page");
    }
    expect(email.subject).toBe("Shipped this week: 2 canvases, 3 pull requests merged");
  });

  test("a payment email links Stripe's invoice only on Stripe's host", () => {
    for (const name of ["billing-payment-no-invoice", "billing-payment-foreign-invoice"]) {
      const email = rendered.get(name)!;
      expect(hrefsOf(email.html).some((href) => href.includes("invoice.stripe.com"))).toBe(false);
      expect(email.text).toContain("Open Plan and usage https://ponzu.design/settings?");
    }
    expect(rendered.get("billing-payment-failed")!.text).toContain(
      "Pay the invoice https://invoice.stripe.com/",
    );
  });

  test("only the emails that can be turned off carry an unsubscribe link", () => {
    for (const [name, email] of rendered) {
      const stop = email.html.includes("/v1/email/unsubscribe");
      const canStop =
        name.startsWith("digest") || name.startsWith("team") || name.startsWith("recap");
      expect({ name, stop }).toEqual({ name, stop: canStop });
    }
  });

  test("no billing email, notice or recap carries a card, a repository or a title", () => {
    for (const email of rendered.values()) {
      expect(email.html).not.toMatch(/\b(4242|visa|mastercard|cus_|pi_|in_1)\b/i);
      expect(email.html).not.toContain("github.com/north-brook/ponzu/pull");
    }
  });
});
