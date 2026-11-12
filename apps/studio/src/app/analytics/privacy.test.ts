import { expect, test } from "bun:test";
import { viewUrl } from "./events.ts";
import {
  placeOnView,
  replayPrivacy,
  SECRET_CLASS,
  scrubLocalPaths,
  scrubNetworkUrl,
  scrubUrl,
} from "./privacy.ts";

const page = { origin: "ponzu-studio://app", replacement: "ponzu://app/design" };

test("a URL sent keeps its origin and path, never a query, a fragment or a file", () => {
  expect(scrubUrl("https://assets-dev.ponzu.cloud/k/a.png?X-Amz-Signature=secret#x", page)).toBe(
    "https://assets-dev.ponzu.cloud/k/a.png",
  );
  expect(scrubUrl("https://api.ponzu.design/v1/me?token=1", page)).toBe(
    "https://api.ponzu.design/v1/me",
  );
  expect(scrubUrl("ponzu-studio://app/assets/index.js", page)).toBe("ponzu://app/design");
  expect(scrubUrl("file:///Users/maya/Library/x", page)).toBe("ponzu://app/design");
  expect(scrubUrl("not a url", page)).toBe("not a url");
});

test("network timing keeps an API request's path, and of anything else only its origin", () => {
  const network = { ...page, api: "https://api.ponzu.design" };
  // A design's files sit under its asset key, the capability to read them.
  expect(scrubNetworkUrl("https://assets.ponzu.cloud/k3y/assets/a.png?v=1", network)).toBe(
    "https://assets.ponzu.cloud",
  );
  expect(scrubNetworkUrl("https://assets.ponzu.cloud/pull-requests/k3y/light.png", network)).toBe(
    "https://assets.ponzu.cloud",
  );
  expect(scrubNetworkUrl("https://api.ponzu.design/v1/designs/dsn_1?x=1", network)).toBe(
    "https://api.ponzu.design/v1/designs/dsn_1",
  );
  expect(scrubNetworkUrl("ponzu-studio://app/assets/index.js", network)).toBe("ponzu://app/design");
});

test("an event says the view it happened in, never the page's address or a referrer", () => {
  const place = { url: "ponzu://app/create", path: "/create", host: "app" };
  const properties = placeOnView(
    {
      $current_url: "http://localhost:5173/",
      $pathname: "/",
      $host: "localhost:5173",
      $referrer: "http://localhost:5173/",
      $referring_domain: "localhost:5173",
      design_id: "dsn_1",
    },
    place,
    true,
  );
  expect(properties).toEqual({
    $current_url: "ponzu://app/create",
    $pathname: "/create",
    $host: "app",
    $referrer: "$direct",
    $referring_domain: "$direct",
    design_id: "dsn_1",
  });
  // What PostHog keeps as the first, rewritten too; nothing added that wasn't there.
  expect(placeOnView({ $initial_current_url: "file:///x" }, place, false)).toEqual({
    $initial_current_url: "ponzu://app/create",
  });
});

test("each view has a stable synthetic URL, and a design's only its id", () => {
  expect(viewUrl({ name: "design", designId: "dsn_1", tab: "boards" })).toEqual({
    url: "ponzu://app/design",
    path: "/design",
    properties: { design_id: "dsn_1" },
  });
  expect(viewUrl({ name: "settings", section: "members" }).url).toBe(
    "ponzu://app/settings/members",
  );
  expect(viewUrl({ name: "setup", step: "claude" }).url).toBe("ponzu://app/setup/claude");
});

test("a development build's paths lose the checkout's folders", () => {
  expect(
    scrubLocalPaths(
      "at http://localhost:5173/@fs/Users/maya/code/ponzu/packages/canvas/src/a.ts:1",
    ),
  ).toBe("at http://localhost:5173/@fs/…/packages/canvas/src/a.ts:1");
});

test("secrets are blocked in both modes; a design's pixels and words only in private", () => {
  const full = replayPrivacy("full");
  const closed = replayPrivacy("private");
  for (const mode of [full, closed]) {
    expect(mode.blockClass).toBe(SECRET_CLASS);
    expect(mode.maskAllInputs).toBe(true);
  }
  expect(full.blockSelector).toBeNull();
  expect(full.maskTextSelector).toBeNull();
  expect(full.maskAttributeFn).toBeNull();
  expect(closed.blockSelector).toContain("[data-artboard-host]");
  // The thread's attachments: a person's pictures, at addresses under the asset key.
  expect(closed.blockSelector).toContain("#thread img");
  expect(closed.maskTextSelector).toContain("#thread");
  const inThread = { closest: (s: string) => (s.includes("#thread") ? {} : null) } as Element;
  expect(closed.maskAttributeFn!("aria-label", "Pricing page", inThread)).toBe("************");
  expect(closed.maskAttributeFn!("class", "flex", inThread)).toBe("flex");
  const outside = { closest: () => null } as unknown as Element;
  expect(closed.maskAttributeFn!("aria-label", "Settings", outside)).toBe("Settings");
});
