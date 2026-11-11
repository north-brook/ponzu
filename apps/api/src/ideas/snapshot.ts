import type { GithubTree } from "../deps/github.ts";

/*
 * What a light read of a repository keeps, and how it picks what to read: enough to know what
 * the product is and what its interface is made of, from its tree and a handful of files.
 * Everything here is pure: `read-repo.ts` does the reading, and the prompt (`prompt.ts`)
 * renders what is kept, fenced as data. All of it came from the repository, so none of it is
 * trusted: it is cut to size here, and never treated as instructions.
 *
 * The budget, at most, for one repository:
 *   reads    8 GitHub requests: the repo, its tree, its README, 4 manifests, 1 theme file
 *            (plus the one that mints the token); a repo with nothing built yet spends what
 *            its missing manifests leave on up to 2 of its few files instead
 *   bytes    the tree as far as GitHub lists it (it stops at 100,000 entries or 7 MB);
 *            a manifest or theme file only when the tree says it is under 64 KiB; the README
 *            cut at 64 KiB (GitHub sends at most 1 MB of any file's content)
 *   prompt   about 18,000 characters of repository text (about 5,000 tokens)
 */

export const BUDGET = {
  fileBytes: 64 * 1024,
  manifests: 4,
  /** Characters kept of each part. */
  description: 400,
  topics: 20,
  readme: 5_000,
  manifest: 1_400,
  theme: 2_200,
  /** A repo with nothing built yet: how many of its own files are read, how large, how much kept. */
  samples: 2,
  sampleBytes: 16 * 1024,
  sample: 1_500,
  layout: 2_200,
  screens: 4_000,
  components: 1_400,
} as const;

/** What the read kept of one repository. */
export interface RepoSnapshot {
  fullName: string;
  description: string | null;
  topics: string[];
  language: string | null;
  /** The README, without images, badges, markup, code blocks or addresses, cut to size. */
  readme: string | null;
  /** The top two levels of the tree, one line per folder. */
  layout: string[];
  manifests: { path: string; summary: string }[];
  /** Routes, pages and screens found by the conventions of common stacks, by app. */
  screens: { where: string; kind: string; names: string[] }[];
  components: string[];
  theme: { path: string; excerpt: string } | null;
  /** Whether the interface has a dark theme already, as far as names and the theme show. */
  darkTheme: boolean;
  /** For a repo with nothing built yet (`isUnbuilt`), the start of each of a few of its files. */
  samples: { path: string; excerpt: string }[];
  /** How many files the tree has. */
  files: number;
}

/** Folders that say nothing about the product: dependencies, builds, tests, tooling. */
const SKIPPED =
  /(^|\/)(node_modules|vendor|dist|build|out|target|tmp|coverage|Pods|DerivedData|storybook-static|__tests__|__mocks__|__snapshots__|tests?|specs?|e2e|cypress|playwright|fixtures|mocks|migrations|locales?|i18n)(\/|$)|(^|\/)\./;
/** Files nobody reads for what a product is: binaries, lockfiles, generated or minified. */
const NOISE =
  /\.(test|spec|e2e)\.[a-z]+$|\.(png|jpe?g|gif|webp|avif|ico|icns|svg|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|webm|wasm|so|dylib|a|jar|bin|lock|map|min\.js|min\.css|snap)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Podfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock|go\.sum)$/i;

const kept = (path: string) => !SKIPPED.test(path) && !NOISE.test(path);

/* ------------------------------------------------------------------ */
/* What to read                                                         */
/* ------------------------------------------------------------------ */

const MANIFEST =
  /(^|\/)(package\.json|Gemfile|requirements\.txt|pyproject\.toml|Pipfile|composer\.json|go\.mod|Cargo\.toml|Package\.swift|Podfile|pubspec\.yaml|build\.gradle(\.kts)?|mix\.exs)$/;
/** Where an app, rather than a library or a tool, usually lives in a monorepo. */
const APP_LIKE =
  /(^|\/)(apps?|web|site|www|frontend|client|mobile|ios|android|ui|storefront|dashboard)(\/|$)/i;

/** Up to `BUDGET.manifests` package manifests: the top level's first, then the apps'. */
export function pickManifests(tree: GithubTree): string[] {
  const depth = (path: string) => path.split("/").length - 1;
  return (
    tree.entries
      .filter((entry) => entry.type === "blob" && kept(entry.path) && MANIFEST.test(entry.path))
      .map((entry) => entry.path)
      // An app's own manifest is at most two folders down (`apps/web/`); deeper ones are its parts.
      .filter((path) => depth(path) <= 2)
      .sort(
        (a, b) =>
          Number(depth(a) > 0) - Number(depth(b) > 0) ||
          Number(!APP_LIKE.test(a)) - Number(!APP_LIKE.test(b)) ||
          depth(a) - depth(b) ||
          a.localeCompare(b),
      )
      .slice(0, BUDGET.manifests)
  );
}

/** Where design decisions are written down, most telling first. */
const THEME: RegExp[] = [
  /(^|\/)(design-)?tokens?(\.[a-z]+)?\.(json|css|scss|ts|js|ya?ml)$|(^|\/)tokens\/[^/]+\.(json|css|ts|js)$|(^|\/)[\w-]*design[-_]?system[\w-]*\.(s?css|json|ts)$/i,
  /(^|\/)tailwind\.config\.(js|ts|cjs|mjs)$/,
  /(^|\/)theme\.(ts|js|json)$|(^|\/)theme\/(index|colors|tokens)\.(ts|js)$|(^|\/)(Colors|Theme)\.swift$|(^|\/)values\/colors\.xml$/,
  /(^|\/)(globals?|app|application|main|index|variables|_variables|theme|styles)\.(s?css)$|(^|\/)tailwind\/[^/]+\.css$/,
];

/** A dark theme shows in a file's name (`dark.css`, `DarkTheme.ts`) or in the theme's text. */
export function hasDarkTheme(tree: GithubTree, themeText: string | null): boolean {
  const named = tree.entries.some(
    ({ path }) => kept(path) && /(^|[/_.-])dark([/_.-]|[A-Z]|$)|Dark(Theme|Mode)/.test(path),
  );
  return named || /\bdark\b|prefers-color-scheme|\.dark\b|dark:/i.test(themeText ?? "");
}

/** The one file that best says what the interface's colors and type are, if any does. */
export function pickTheme(tree: GithubTree): string | null {
  const files = tree.entries
    .filter((entry) => entry.type === "blob" && kept(entry.path))
    .map((entry) => entry.path)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const pattern of THEME) {
    const found = files.find((path) => pattern.test(path));
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* What the tree shows                                                  */
/* ------------------------------------------------------------------ */

/** The top two levels: each top folder with what is in it, then the files at the top. */
export function layoutOf(tree: GithubTree): string[] {
  const children = new Map<string, Set<string>>();
  const topFiles: string[] = [];
  for (const { path, type } of tree.entries) {
    if (SKIPPED.test(path) || (type === "blob" && NOISE.test(path))) continue;
    const parts = path.split("/");
    if (parts.length === 1) {
      if (type === "tree") children.set(parts[0]!, children.get(parts[0]!) ?? new Set());
      else topFiles.push(parts[0]!);
      continue;
    }
    const top = children.get(parts[0]!) ?? new Set<string>();
    children.set(parts[0]!, top);
    if (parts.length === 2) top.add(type === "tree" ? `${parts[1]}/` : parts[1]!);
  }
  const lines = [...children.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, inside]) => {
      const names = [...inside].sort((a, b) => Number(!a.endsWith("/")) - Number(!b.endsWith("/")));
      const shown = names.slice(0, 14).join(", ");
      const more = names.length > 14 ? `, and ${names.length - 14} more` : "";
      return `${folder}/: ${shown}${more}`;
    });
  if (topFiles.length) lines.push(`(top-level files): ${topFiles.sort().slice(0, 30).join(", ")}`);
  return cutLines(lines, BUDGET.layout);
}

interface ScreenRule {
  kind: string;
  /** The path matched; the first group is where the app is, the second the route or name. */
  pattern: RegExp;
  label: (match: RegExpExecArray) => string | null;
}

const route = (dir: string | undefined) => {
  const segments = (dir ?? "")
    .split("/")
    .filter((segment) => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
  return `/${segments.join("/")}`;
};
const stripIndex = (path: string) => route(path.replace(/(^|\/)index$/, ""));

const SCREEN_RULES: ScreenRule[] = [
  {
    kind: "Next.js app routes",
    pattern: /^(.*?)(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/,
    label: (m) => route(m[2]),
  },
  {
    kind: "SvelteKit routes",
    pattern: /^(.*?)src\/routes\/(?:(.*)\/)?\+page\.svelte$/,
    label: (m) => route(m[2]),
  },
  {
    kind: "Remix routes",
    pattern: /^(.*?)app\/routes\/(.+)\.(?:tsx|jsx|ts|js)$/,
    label: (m) =>
      m[2]!.includes("/") && !m[2]!.endsWith("route") ? null : m[2]!.replace(/\/route$/, ""),
  },
  {
    kind: "pages",
    pattern: /^(.*?)(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|vue|astro|svelte)$/,
    label: (m) =>
      /(^|\/)(_app|_document|_error|api)(\/|$)/.test(m[2]!) ? null : stripIndex(m[2]!),
  },
  {
    kind: "Rails views",
    pattern: /^(.*?)app\/views\/(.+?)(?:\.html|\.turbo_stream)?\.(?:erb|haml|slim)$/,
    label: (m) => (/(^|\/)(_[^/]*|layouts\/.*|.*mailer.*)$/.test(m[2]!) ? null : m[2]!),
  },
  {
    kind: "templates",
    pattern: /^(.*?)templates\/(.+)\.(?:html|jinja2?|j2|hbs|njk)$/,
    label: (m) =>
      /(^|\/)(_[^/]*|base|layout|includes?\/.*|partials?\/.*|emails?\/.*)$/.test(m[2]!)
        ? null
        : m[2]!,
  },
  {
    kind: "Laravel views",
    pattern: /^(.*?)resources\/views\/(.+)\.blade\.php$/,
    label: (m) => (/(^|\/)(layouts|components|partials)\//.test(m[2]!) ? null : m[2]!),
  },
  {
    kind: "Vue views",
    pattern: /^(.*?)(?:src\/)?views\/(.+)\.vue$/,
    label: (m) => m[2]!,
  },
  {
    kind: "LiveViews",
    pattern: /^(.*?)lib\/[^/]+_web\/live\/(.+)\.ex$/,
    label: (m) => (m[2]!.endsWith("component") ? null : m[2]!),
  },
];

/** Expo Router keeps its screens in `app/` beside a `_layout`: what tells it from Next's `app/`. */
const EXPO_LAYOUT = /^(.*?)(?:src\/)?app\/(?:.*\/)?_layout\.(?:tsx|jsx|ts|js)$/;
const EXPO_SCREEN = /^(.*?)(?:src\/)?app\/(.+)\.(?:tsx|jsx|ts|js)$/;
/** A screen by the name each stack gives one: `CartScreen.tsx`, `CartView.swift`, `cart_page.dart`. */
const NAMED_SCREEN = [
  /(?:^|\/)([A-Z][A-Za-z0-9]*(?:Screen|Page))\.(?:tsx|jsx|ts|js)$/,
  /(?:^|\/)([A-Z][A-Za-z0-9]*(?:Screen|View|ViewController))\.swift$/,
  /(?:^|\/)([A-Z][A-Za-z0-9]*(?:Screen|Activity|Fragment))\.(?:kt|java)$/,
  /(?:^|\/)([a-z0-9_]+_(?:screen|page))\.dart$/,
];
/** A screen by where it is: each entry of a `screens/` folder, a file or a folder of its own. */
const SCREEN_FOLDER = /(?:^|\/)(?:screens|scenes)\/([A-Z][^/.]*)[^/]*(\/|\.(?:tsx|jsx|ts|js)$)/;
const COMPONENT =
  /(^|\/)(components|ui|widgets)\/(?:.*\/)?([^/]+)\.(tsx|jsx|vue|svelte|astro|swift|kt|dart)$|(^|\/)([^/]+)\.(component\.ts|stories\.(tsx|jsx|ts|mdx))$/;
/** Icons are components by the hundred, and say nothing of the product. */
const ICONS = /(^|\/)(icons?|glyphs|svgs?|illustrations)\//i;
/** `Button.web.tsx` is `Button`. */
const PLATFORM = /\.(web|ios|android|native|server|client|shared)$/;

/** The routes, pages and screens the tree shows, by where their app is, and its components. */
export function interfaceOf(tree: GithubTree): {
  screens: RepoSnapshot["screens"];
  components: string[];
} {
  const files = tree.entries
    .filter((entry) => entry.type === "blob" && kept(entry.path))
    .map((entry) => entry.path)
    .sort();
  const groups = new Map<string, { where: string; kind: string; names: Set<string> }>();
  const add = (where: string, kind: string, name: string) => {
    const at = where.replace(/\/$/, "") || ".";
    const key = `${at}\n${kind}`;
    const group = groups.get(key) ?? { where: at, kind, names: new Set<string>() };
    groups.set(key, group);
    group.names.add(name);
  };
  const expoRoots = new Set(files.flatMap((path) => EXPO_LAYOUT.exec(path)?.[1] ?? []));
  const components = new Set<string>();

  for (const path of files) {
    let placed = false;
    for (const rule of SCREEN_RULES) {
      const match = rule.pattern.exec(path);
      if (!match) continue;
      const label = rule.label(match);
      if (label) add(match[1]!, rule.kind, label);
      placed = true;
      break;
    }
    if (placed) continue;
    const expo = EXPO_SCREEN.exec(path);
    if (expo && expoRoots.has(expo[1]!) && !/(^|\/)(_layout|\+[^/]*)$/.test(expo[2]!)) {
      if (!/(^|\/)(components?|hooks|lib|utils|constants)\//.test(expo[2]!)) {
        add(expo[1]!, "Expo Router screens", stripIndex(expo[2]!));
        continue;
      }
    }
    const screen =
      NAMED_SCREEN.map((pattern) => pattern.exec(path)?.[1]).find(Boolean) ??
      SCREEN_FOLDER.exec(path)?.[1];
    if (screen) {
      add("", "screens", screen.replace(PLATFORM, ""));
      continue;
    }
    if (/(^|\/)(screens|scenes)\//.test(path) || ICONS.test(path)) continue;
    const component = COMPONENT.exec(path);
    if (component) {
      const name = (component[3] ?? component[6]!).replace(PLATFORM, "");
      const named = name === "index" ? path.split("/").slice(-2, -1)[0]! : name;
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(named)) components.add(named);
    }
  }

  let room = BUDGET.screens;
  const screens: RepoSnapshot["screens"] = [];
  for (const group of [...groups.values()].sort((a, b) => b.names.size - a.names.size)) {
    const names = [...group.names].sort((a, b) => a.localeCompare(b));
    const fits = takeWithin(names, room - group.where.length - group.kind.length - 8);
    if (fits.length === 0) break;
    screens.push({ where: group.where, kind: group.kind, names: fits });
    room -= fits.join(", ").length + group.where.length + group.kind.length + 8;
  }
  return {
    screens,
    components: takeWithin(
      [...components].sort((a, b) => a.localeCompare(b)),
      BUDGET.components,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* What the files say                                                   */
/* ------------------------------------------------------------------ */

/**
 * A README as prose: no images, badges, HTML, code blocks, tables of links or addresses,
 * which say nothing of the product, cost room, and are where an address could slip into an
 * idea from. Cut at a line, to `BUDGET.readme`.
 */
export function cleanReadme(text: string): string | null {
  const cleaned = withoutHowTo(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/^ +| +$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  return cutLines(cleaned.split("\n"), BUDGET.readme).join("\n");
}

/** Sections of a README about working on it rather than what it is. */
const HOW_TO =
  /install|setup|set up|getting started|quick ?start|running|local|develop|contribut|licen[cs]e|deploy|build|test|prerequisite|requirement|environment|configur|changelog|release|sponsor|backer|acknowledg|credit|support|community|conduct|security|fork|faq|troubleshoot|roadmap|author|maintainer|star history|docker/i;

/** The README without its how-to sections: each such heading and what is under it. */
function withoutHowTo(text: string): string {
  const out: string[] = [];
  let skipping: number | null = null;
  for (const line of text.split("\n")) {
    const heading = /^(#{2,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (skipping !== null && level <= skipping) skipping = null;
      if (skipping === null && HOW_TO.test(heading[2]!)) skipping = level;
    }
    if (skipping === null) out.push(line);
  }
  return out.join("\n");
}

/** What a manifest says of the stack: a package's name and dependencies, or the file itself, cut. */
export function summarizeManifest(path: string, text: string): string | null {
  if (path.endsWith("package.json")) {
    let pkg: any;
    try {
      pkg = JSON.parse(text);
    } catch {
      return null;
    }
    const names = (deps: unknown) =>
      deps && typeof deps === "object" ? Object.keys(deps as object).slice(0, 80) : [];
    const lines = [
      typeof pkg.name === "string" ? `name: ${pkg.name}` : null,
      typeof pkg.description === "string" ? `description: ${pkg.description}` : null,
      names(pkg.dependencies).length ? `dependencies: ${names(pkg.dependencies).join(", ")}` : null,
      names(pkg.devDependencies).length
        ? `devDependencies: ${names(pkg.devDependencies).join(", ")}`
        : null,
    ].filter((line): line is string => line !== null);
    return lines.length ? cut(lines.join("\n"), BUDGET.manifest) : null;
  }
  if (/(^|\/)(Gemfile|Podfile)$/.test(path)) {
    const gems = [...text.matchAll(/^\s*(?:gem|pod)\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    return gems.length
      ? cut(`${path.endsWith("Podfile") ? "pods" : "gems"}: ${gems.join(", ")}`, BUDGET.manifest)
      : null;
  }
  if (path.endsWith("requirements.txt")) {
    const packages = text
      .split("\n")
      .map(
        (line) =>
          line
            .replace(/#.*/, "")
            .trim()
            .split(/[<>=!~[; ]/)[0],
      )
      .filter(Boolean);
    return packages.length ? cut(`packages: ${packages.join(", ")}`, BUDGET.manifest) : null;
  }
  const body = text
    .replace(/^\s*(#|\/\/).*$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return body ? cut(body, BUDGET.manifest) : null;
}

/** What a theme file says of colors, type and spacing: a stylesheet's variables, or the file, cut. */
export function excerptTheme(path: string, text: string): string | null {
  let body = text;
  if (/\.s?css$/.test(path)) {
    const lines = text
      .split("\n")
      .filter((line) =>
        /--[\w-]+\s*:|@theme|:root|\.dark|\[data-theme|\$[\w-]+\s*:|@font-face|font-family/.test(
          line,
        ),
      );
    if (lines.length === 0) return null;
    body = lines.map((line) => line.trim()).join("\n");
  } else {
    body = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\n\s*\n/g, "\n")
      .trim();
  }
  return body ? cut(body, BUDGET.theme) : null;
}

/**
 * The most files a repo with nothing built yet has. Past this, what is there is something,
 * even with no screens: a library, a tool, a backend, which the usual ideas fit.
 */
const UNBUILT_FILES = 8;

/**
 * Whether the product is not built yet: no screens, no components, no theme and only a few
 * files (a README, a first file or two). Its ideas are then where to start designing it, not
 * changes to screens it does not have (`FRESH_SYSTEM_PROMPT` in prompt.ts; docs/cloud.md,
 * "Ideas"). Known from the tree alone, before any file is read.
 */
export function isUnbuilt(snapshot: {
  screens: unknown[];
  components: unknown[];
  /** The theme file, if one was found. */
  theme: unknown;
  files: number;
}): boolean {
  return (
    snapshot.screens.length === 0 &&
    snapshot.components.length === 0 &&
    snapshot.theme === null &&
    snapshot.files < UNBUILT_FILES
  );
}

/** Text a person wrote, as far as a name says: prose, markup, styles, code, data. */
const TEXT =
  /\.(md|mdx|txt|rst|adoc|html?|css|s[ac]ss|tsx?|jsx?|mjs|cjs|vue|svelte|astro|py|rb|go|rs|swift|kt|java|dart|ex|php|json|ya?ml|toml)$/i;
/** Files that say how a repo is kept, not what the product is. */
const HOUSEKEEPING =
  /(^|\/)(readme|licen[cs]e|copying|changelog|contributing|code_of_conduct|security)(\.[a-z]+)?$/i;

/**
 * Which of a repo's few files to read when nothing is built yet, besides its README and
 * manifests (`skip`): up to `limit`, small and text, what says most of what people will see
 * (a first page, then prose, then the rest), each under `BUDGET.sampleBytes` by the tree's count.
 */
export function pickSamples(tree: GithubTree, skip: string[], limit: number): string[] {
  const rank = (path: string) =>
    /\.(html?|vue|svelte|astro)$/i.test(path) ? 0 : /\.(md|mdx|txt|rst|adoc)$/i.test(path) ? 1 : 2;
  return tree.entries
    .filter(
      ({ path, type, size }) =>
        type === "blob" &&
        kept(path) &&
        TEXT.test(path) &&
        !HOUSEKEEPING.test(path) &&
        !skip.includes(path) &&
        (size ?? 0) > 0 &&
        (size ?? 0) <= BUDGET.sampleBytes,
    )
    .map(({ path }) => path)
    .sort(
      (a, b) =>
        rank(a) - rank(b) || a.split("/").length - b.split("/").length || a.localeCompare(b),
    )
    .slice(0, Math.max(0, limit));
}

/** The start of a file, as data: no addresses or runs of blank lines, cut at a line. */
export function excerptSample(text: string): string | null {
  const body = text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = body ? cutLines(body.split("\n"), BUDGET.sample) : [];
  return lines.length ? lines.join("\n") : null;
}

/* ------------------------------------------------------------------ */

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`;
}

/** Whole lines, as many as fit in `max` characters. */
function cutLines(lines: string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const piece = line.length > max ? cut(line, max) : line;
    if (used + piece.length + 1 > max) break;
    out.push(piece);
    used += piece.length + 1;
  }
  return out;
}

/** As many of `names` as fit in `max` characters, joined by commas. */
function takeWithin(names: string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const name of names) {
    if (used + name.length + 2 > max) break;
    out.push(name);
    used += name.length + 2;
  }
  return out;
}
