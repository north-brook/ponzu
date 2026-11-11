import { describe, expect, test } from "bun:test";
import type { GithubTree } from "../deps/github.ts";
import {
  BUDGET,
  cleanReadme,
  excerptTheme,
  hasDarkTheme,
  interfaceOf,
  isEmpty,
  layoutOf,
  pickManifests,
  pickTheme,
  summarizeManifest,
} from "./snapshot.ts";

const tree = (...paths: string[]): GithubTree => ({
  entries: paths.map((path) => ({ path, type: "blob", size: 100 })),
  complete: true,
});

describe("interfaceOf", () => {
  test("reads routes by each stack's own conventions", () => {
    const { screens } = interfaceOf(
      tree(
        "apps/web/app/page.tsx",
        "apps/web/app/(shop)/checkout/page.tsx",
        "apps/web/app/products/[handle]/page.tsx",
        "apps/web/app/layout.tsx",
        "app/views/orders/index.html.erb",
        "app/views/orders/_row.html.erb",
        "app/views/layouts/application.html.erb",
        "src/routes/settings/+page.svelte",
        "pages/index.vue",
        "pages/_app.tsx",
        "pages/api/hello.ts",
        "shop/templates/shop/basket.html",
        "shop/templates/base.html",
      ),
    );
    expect(screens).toEqual(
      expect.arrayContaining([
        {
          where: "apps/web",
          kind: "Next.js app routes",
          names: ["/", "/checkout", "/products/[handle]"],
        },
        { where: ".", kind: "Rails views", names: ["orders/index"] },
        { where: ".", kind: "SvelteKit routes", names: ["/settings"] },
        { where: ".", kind: "pages", names: ["/"] },
        { where: "shop", kind: "templates", names: ["shop/basket"] },
      ]),
    );
  });

  test("tells Expo Router's app folder from Next's by its _layout, and names native screens", () => {
    const { screens } = interfaceOf(
      tree(
        "app/_layout.tsx",
        "app/(tabs)/index.tsx",
        "app/(tabs)/profile.tsx",
        "app/+not-found.tsx",
        "src/screens/Settings/AppearanceSettings.tsx",
        "src/screens/Settings/util.ts",
        "src/screens/hooks/useThing.ts",
        "src/screens/Home.tsx",
        "ios/Shop/CartView.swift",
        "android/app/src/main/java/OrdersActivity.kt",
        "lib/screens/checkout_screen.dart",
      ),
    );
    expect(screens).toEqual(
      expect.arrayContaining([
        { where: ".", kind: "Expo Router screens", names: ["/", "/profile"] },
        {
          where: ".",
          kind: "screens",
          names: ["CartView", "checkout_screen", "Home", "OrdersActivity", "Settings"],
        },
      ]),
    );
  });

  test("names components, without icons, tests or platform twins", () => {
    const { components } = interfaceOf(
      tree(
        "src/components/Button.tsx",
        "src/components/Button.web.tsx",
        "src/components/Button.test.tsx",
        "src/components/cart/index.tsx",
        "src/components/icons/Bell.tsx",
        "src/app/order.component.ts",
        "node_modules/x/components/Nope.tsx",
      ),
    );
    expect(components).toEqual(["Button", "cart", "order"]);
  });
});

describe("what to read", () => {
  test("manifests: the top level's first, then an app's, never a dependency's or a part's", () => {
    expect(
      pickManifests(
        tree(
          "packages/ui/package.json",
          "apps/web/package.json",
          "package.json",
          "Gemfile",
          "modules/sheet/android/build.gradle",
          "node_modules/react/package.json",
        ),
      ),
    ).toEqual(["Gemfile", "package.json", "apps/web/package.json", "packages/ui/package.json"]);
  });

  test("the theme: tokens over a Tailwind config over a stylesheet", () => {
    expect(pickTheme(tree("app/globals.css", "tailwind.config.ts", "src/tokens.json"))).toBe(
      "src/tokens.json",
    );
    expect(pickTheme(tree("app/globals.css", "tailwind.config.ts"))).toBe("tailwind.config.ts");
    expect(pickTheme(tree("app/assets/tailwind/maybe-design-system.css"))).toBe(
      "app/assets/tailwind/maybe-design-system.css",
    );
    expect(pickTheme(tree("README.md"))).toBeNull();
  });

  test("a dark theme, from a name or the theme's text", () => {
    expect(hasDarkTheme(tree("src/themes/dark.ts"), null)).toBe(true);
    expect(hasDarkTheme(tree("src/theme.ts"), "@media (prefers-color-scheme: dark) {}")).toBe(true);
    expect(hasDarkTheme(tree("src/theme.ts", "src/darkness/x.ts"), "--leaf: green")).toBe(false);
  });
});

describe("what is kept of a file", () => {
  test("a README loses markup, code, addresses and how-to sections, and is cut to size", () => {
    const readme = [
      "# Fernwood",
      '<p align="center"><img src="logo.png"></p>',
      "[![build](https://ci/badge.svg)](https://ci)",
      "A shop for **house plants**: see [the guide](https://fernwood.example/guide).",
      "Visit https://fernwood.example today.",
      "```sh",
      "npm install",
      "```",
      "## Features",
      "Care guides for every plant.",
      "## Getting started",
      "Run the dev server.",
      "### Environment",
      "Set the keys.",
      "## Pricing",
      "Free shipping over $50.",
    ].join("\n");
    expect(cleanReadme(readme)).toBe(
      "# Fernwood\n\nA shop for **house plants**: see the guide.\nVisit today.\n\n## Features\nCare guides for every plant.\n## Pricing\nFree shipping over $50.",
    );
    expect(cleanReadme("word ".repeat(5_000))!.length).toBeLessThanOrEqual(BUDGET.readme + 2);
    expect(cleanReadme("<!-- nothing -->")).toBeNull();
  });

  test("a package.json is its name and dependencies; a lockfile-sized one is cut", () => {
    const pkg = JSON.stringify({
      name: "shop",
      version: "1.0.0",
      scripts: { dev: "next dev" },
      dependencies: { next: "16", react: "19" },
      devDependencies: { tailwindcss: "4" },
    });
    expect(summarizeManifest("package.json", pkg)).toBe(
      "name: shop\ndependencies: next, react\ndevDependencies: tailwindcss",
    );
    expect(summarizeManifest("package.json", "{ broken")).toBeNull();
    expect(summarizeManifest("Gemfile", 'source "x"\ngem "rails"\ngem "turbo-rails"')).toBe(
      "gems: rails, turbo-rails",
    );
  });

  test("a stylesheet is its variables", () => {
    expect(
      excerptTheme(
        "app/globals.css",
        ":root {\n  --leaf: #2f6b3a;\n}\nbody { margin: 0 }\n.dark { }",
      ),
    ).toBe(":root {\n--leaf: #2f6b3a;\n.dark { }");
    expect(excerptTheme("app/globals.css", "body { margin: 0 }")).toBeNull();
  });
});

describe("layoutOf and isEmpty", () => {
  test("the top two levels, without dependencies or dot folders", () => {
    expect(
      layoutOf({
        entries: [
          { path: "app", type: "tree", size: null },
          { path: "app/cart", type: "tree", size: null },
          { path: "app/page.tsx", type: "blob", size: 1 },
          { path: "app/cart/page.tsx", type: "blob", size: 1 },
          { path: ".github", type: "tree", size: null },
          { path: "node_modules", type: "tree", size: null },
          { path: "logo.png", type: "blob", size: 1 },
          { path: "README.md", type: "blob", size: 1 },
        ],
        complete: true,
      }),
    ).toEqual(["app/: cart/, page.tsx", "(top-level files): README.md"]);
  });

  test("a repo with only a short README is empty; any interface is not", () => {
    const base = {
      fullName: "a/b",
      description: null,
      topics: [],
      language: null,
      readme: "# b",
      layout: [],
      manifests: [],
      screens: [],
      components: [],
      theme: null,
      darkTheme: false,
      files: 1,
    };
    expect(isEmpty(base)).toBe(true);
    expect(isEmpty({ ...base, components: ["Button"] })).toBe(false);
    expect(isEmpty({ ...base, readme: "A product. ".repeat(40) })).toBe(false);
  });
});
