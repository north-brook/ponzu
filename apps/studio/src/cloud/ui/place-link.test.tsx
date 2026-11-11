import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDesignAddress } from "./design-address.ts";
import { settled } from "./markdown.ts";
import { type DesignPlaces, DesignPlacesProvider } from "./place-link.tsx";
import { Prose } from "./prose.tsx";
import { TipProvider } from "./tooltip.tsx";

/*
 * Links to a page or board of a design in the agent's words: which addresses are ours, how the
 * thread draws them, and a link still being written while a reply streams in.
 */

const ORIGIN = "https://ponzu.design/designs/des_1";

test("our own design's address, and a page or board of it, are recognised exactly", () => {
  expect(parseDesignAddress(ORIGIN)).toEqual({ designId: "des_1" });
  expect(parseDesignAddress(`${ORIGIN}/`)).toEqual({ designId: "des_1" });
  expect(parseDesignAddress(`${ORIGIN}?artboard=ab_x1`)).toEqual({
    designId: "des_1",
    artboard: "ab_x1",
  });
  expect(parseDesignAddress(`${ORIGIN}?page=pg_2#top`)).toEqual({
    designId: "des_1",
    page: "pg_2",
  });
  // What the web page adds for Ponzu Preview doesn't change the place.
  expect(parseDesignAddress(`${ORIGIN}?artboard=ab_1&app=ponzu-preview`)).toEqual({
    designId: "des_1",
    artboard: "ab_1",
  });
});

test("an address dressed as ours, but not ours, is an ordinary link", () => {
  for (const href of [
    "http://ponzu.design/designs/des_1?artboard=ab_1",
    "https://ponzu.design.evil.test/designs/des_1?artboard=ab_1",
    "https://evil.test/designs/des_1?artboard=ab_1",
    "https://ponzu.design@evil.test/designs/des_1",
    "https://user:pw@ponzu.design/designs/des_1",
    "https://ponzu.design:8443/designs/des_1",
    "https://www.ponzu.design/designs/des_1",
    "https://ponzu.design/designs/des_1/settings",
    "https://ponzu.design/designs/",
    "https://ponzu.design/local#file=/x.design&artboard=ab_1",
    "https://ponzu.design/designs/des 1",
    "https://ponzu.design/designs/des_1?artboard=ab_1&artboard=ab_2",
    "https://ponzu.design/designs/des_1?artboard=%3Cscript%3E",
    "https://ponzu.design/designs/des_1?page=",
    "ponzu://design/des_1?artboard=ab_1",
    "javascript:alert(1)//https://ponzu.design/designs/des_1",
  ]) {
    expect(parseDesignAddress(href)).toBeNull();
  }
});

const places = (over: Partial<DesignPlaces> = {}): DesignPlaces => ({
  designId: "des_1",
  has: (at) => at.artboard !== "ab_gone" && at.page !== "pg_gone",
  open: () => {},
  ...over,
});

const drawn = (text: string, value: DesignPlaces | null = places()) => {
  const prose = <Prose text={text} />;
  const tree: ReactNode = value ? (
    <DesignPlacesProvider value={value}>{prose}</DesignPlacesProvider>
  ) : (
    prose
  );
  return renderToStaticMarkup(<TipProvider>{tree}</TipProvider>);
};

test("in a design's thread a link to one of its boards or pages stays in the app", () => {
  const board = drawn(`The options are on [Note: Pricing](${ORIGIN}?artboard=ab_x1).`);
  expect(board).toContain('data-place="board"');
  expect(board).toContain(`href="${ORIGIN}?artboard=ab_x1"`);
  expect(board).not.toContain("target=");
  expect(board).toContain(">Note: Pricing</a>");
  const page = drawn(`See [Mobile](${ORIGIN}?page=pg_2).`);
  expect(page).toContain('data-place="page"');
  // Another design's address opens that design, in the app too.
  expect(drawn(`[Checkout](https://ponzu.design/designs/des_9?artboard=ab_1)`)).toContain(
    'data-place="other-design"',
  );
});

test("a link to a board that isn't there any more reads as muted text, not a link", () => {
  const out = drawn(`It was on [Hero / B](${ORIGIN}?artboard=ab_gone).`);
  expect(out).not.toContain("<a");
  expect(out).toContain('data-place="gone"');
  expect(out).toContain(">Hero / B</span>");
  expect(drawn(`[Old](${ORIGIN}?page=pg_gone)`)).toContain('data-place="gone"');
  // While the design is still loading nothing is known gone: it stays a link.
  expect(drawn(`[Hero](${ORIGIN}?artboard=ab_1)`, places({ has: () => undefined }))).toContain(
    'data-place="board"',
  );
});

test("everything else is the link it was, and outside a design ours is too", () => {
  const out = drawn(
    "[docs](https://ponzu.design/docs) and [evil](https://evil.test/designs/des_1)",
  );
  expect(out.match(/target="_blank"/g)).toHaveLength(2);
  expect(out).not.toContain("data-place");
  // A pull request's tab has no design to follow it in: an ordinary link that leaves the app.
  const outside = drawn(`[Note](${ORIGIN}?artboard=ab_1)`, null);
  expect(outside).toContain('target="_blank"');
  expect(outside).not.toContain("data-place");
  // Nothing the rules refuse becomes one by looking like ours.
  expect(drawn("[x](javascript:alert('https://ponzu.design/designs/des_1'))")).not.toContain("<a");
});

test("a link still being written at a streaming reply's end shows as its words alone", () => {
  expect(settled("The options are on [Note: Pri")).toBe("The options are on Note: Pri");
  expect(settled("on [Note: Pricing]")).toBe("on Note: Pricing");
  expect(settled("on [Note: Pricing](")).toBe("on Note: Pricing");
  expect(settled("on [Note: Pricing](https://ponzu.des")).toBe("on Note: Pricing");
  // Closed, it is left to be a link; as is anything that isn't a link at the end.
  const closed = `on [Note: Pricing](${ORIGIN}?artboard=ab_1)`;
  expect(settled(closed)).toBe(closed);
  expect(settled(`${closed} and the`)).toBe(`${closed} and the`);
  expect(settled("a [b](c) then [d")).toBe("a [b](c) then d");
  // A title still being written, and an image's link, show only their words too.
  expect(settled('on [Note](https://ponzu.design/designs/des_1 "ti')).toBe("on Note");
  expect(settled('on [Note](https://ponzu.design/designs/des_1 "title"')).toBe("on Note");
  expect(settled("see ![the chart](https://exa")).toBe("see the chart");
  // In code it is what was written.
  expect(settled("run `arr[i")).toBe("run `arr[i");
  expect(settled("```\nconst a = b[")).toBe("```\nconst a = b[");
  // Hostile text streaming in costs it next to nothing.
  const fill = (unit: string) => unit.repeat(Math.ceil(65_536 / unit.length)).slice(0, 65_536);
  for (const text of [
    fill("[a "),
    fill("![a "),
    fill('[a](b "x '),
    fill("[a](b "),
    `[a](b "${fill("[a](b ")}`,
    fill("[a](b 'x"),
    fill("[a]("),
  ]) {
    const started = performance.now();
    settled(text);
    expect(performance.now() - started).toBeLessThan(50);
  }
  // Drawn, no half address and no bracket ever shows.
  const out = renderToStaticMarkup(
    <Prose text="on [Note: Pricing](https://ponzu.design/des" streaming />,
  );
  expect(out).toContain(">on Note: Pricing</p>");
  expect(out).not.toContain("<a");
});
