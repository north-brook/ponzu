import { describe, expect, test } from "bun:test";
import { type Handoff, handoffPolicy, isAppLink, renderHandoff } from "./handoff.ts";

const opened = { title: "Done", body: "Ponzu has it. You can close this tab." };

function withLink(href: string): Handoff {
  return {
    documentTitle: "Done",
    view: { title: "Done", body: "Opening Ponzu…" },
    link: { href, app: "Ponzu", opened, missed: { title: "Done", body: "It catches up." } },
  };
}

describe("the links a handoff may open", () => {
  test("only the apps' own, with plain paths", () => {
    for (const href of [
      "ponzu://github/setup?result=installed&workspace=ws_1",
      "ponzu-dev://design/dsn_1?page=pg_1",
      "ponzu-preview://github/setup?result=pending",
    ]) {
      expect(isAppLink(href)).toBe(true);
    }
    for (const href of [
      "javascript:alert(1)",
      "https://evil.example",
      "http://ponzu.design",
      "PONZU://x",
      "ponzu-dev:x",
      'ponzu://x"><script>',
      "ponzu://x y",
      "data:text/html,x",
      "x-ponzu://x",
    ]) {
      expect(isAppLink(href)).toBe(false);
    }
  });

  test("anything else is refused before a page is made", async () => {
    await expect(renderHandoff(withLink("https://evil.example"))).rejects.toThrow();
    await expect(renderHandoff(withLink("javascript:alert(1)"))).rejects.toThrow();
  });
});

describe("the document", () => {
  test("words are only ever words", async () => {
    const { html } = await renderHandoff({
      documentTitle: "</title><script>alert(1)</script>",
      view: { title: '<img src=x onerror="alert(2)">', body: "A & B <b>bold</b>" },
      link: null,
    });
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("A &amp; B &lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; · Ponzu</title>");
  });

  test("with a link: three views (opening, opened, missed) and the link as the way again", async () => {
    const { html } = await renderHandoff(withLink("ponzu-dev://github/setup?result=pending&a=b"));
    const main = html.match(/<main [^>]*>/)![0];
    expect(main).toContain('data-state="opening"');
    expect(main).toContain('data-link="ponzu-dev://github/setup?result=pending&amp;a=b"');
    expect(main).toContain('role="status"');
    expect(html.match(/<section /g)).toHaveLength(3);
    expect(html).toContain('href="ponzu-dev://github/setup?result=pending&amp;a=b" data-retry>');
  });

  test("without one: one view, closing only when told the app has it", async () => {
    const base = { documentTitle: "Hi", view: opened, link: null };
    const stays = (await renderHandoff(base)).html;
    const closes = (await renderHandoff({ ...base, closes: true })).html;
    expect(stays.match(/<section /g)).toHaveLength(1);
    expect(stays.match(/<main [^>]*>/)![0]).not.toContain("data-closes");
    expect(closes.match(/<main [^>]*>/)![0]).toContain('data-closes="true"');
    expect(closes).not.toContain("data-retry>");
  });

  test("every page carries the site's lockup, outlined, so the corner needs no font", async () => {
    for (const page of [
      withLink("ponzu://github/setup?result=pending"),
      { documentTitle: "Hi", view: opened, link: null },
    ]) {
      const { html } = await renderHandoff(page);
      const header = html.match(/<header>([\s\S]*?)<\/header>/)![1]!;
      expect(header).toContain('aria-label="Ponzu"');
      expect(header.match(/<path /g)).toHaveLength(7);
      expect(header).not.toContain("<text");
    }
  });

  test("the policy allows its one script and one style sheet by hash, and nothing else", async () => {
    const { html, csp } = await renderHandoff(withLink("ponzu://github/setup?result=pending"));
    expect(csp).toBe(await handoffPolicy());
    expect(csp).toMatch(
      /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]+=*'; style-src 'sha256-[A-Za-z0-9+/]+=*'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/,
    );
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    expect(csp).toContain(await sha256(script));
    expect(csp).toContain(await sha256(style));
    // The page asks for nothing: the one address in its style sheet is the display face,
    // carried inside it.
    expect(style.match(/url\(/g)).toHaveLength(1);
    expect(style).toContain("src: url(data:font/woff2;base64,");
    expect(html).not.toMatch(/<link|<img|src="http/);
    // What varies is never in the script or the style, so the hashes hold for every page.
    const other = await renderHandoff({ documentTitle: "X", view: opened, link: null });
    expect(other.html).toContain(`<script>${script}</script>`);
    expect(other.html).toContain(`<style>${style}</style>`);
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${Buffer.from(digest).toString("base64")}'`;
}
