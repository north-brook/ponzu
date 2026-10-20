import type { CSSProperties, ReactNode } from "react";
import { type BundledLanguage, getSingletonHighlighter, type ThemeRegistration } from "shiki";

/** Token colors are CSS variables, so one tokenization serves every surface and color scheme. */
const theme: ThemeRegistration = {
  name: "ponzu",
  type: "dark",
  colors: { "editor.foreground": "var(--sh-fg)", "editor.background": "transparent" },
  tokenColors: [
    { scope: ["comment"], settings: { foreground: "var(--sh-comment)", fontStyle: "italic" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "var(--sh-punct)" } },
    {
      scope: [
        "entity.other.attribute-name.class.css",
        "entity.other.attribute-name.pseudo-class.css",
        "entity.other.attribute-name.pseudo-element.css",
        "entity.name.tag",
      ],
      settings: { foreground: "var(--sh-tag)" },
    },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--sh-attr)" } },
    { scope: ["support.type.property-name"], settings: { foreground: "var(--sh-prop)" } },
    {
      scope: ["variable", "support.type.custom-property"],
      settings: { foreground: "var(--sh-var)" },
    },
    {
      scope: [
        "constant.numeric",
        "keyword.other.unit",
        "constant.other.color",
        "entity.other.keyframe-offset",
      ],
      settings: { foreground: "var(--sh-num)" },
    },
    { scope: ["support.function"], settings: { foreground: "var(--sh-fn)" } },
    { scope: ["keyword", "storage"], settings: { foreground: "var(--sh-key)" } },
    { scope: ["string"], settings: { foreground: "var(--sh-str)" } },
    { scope: ["support.constant"], settings: { foreground: "var(--sh-fg)" } },
  ],
};

const highlighter = getSingletonHighlighter({ themes: [theme], langs: ["css", "html"] });

const ITALIC = 1;
const BOLD = 2;

export type LineMark = "add" | "del" | undefined;

/** Tokenizes on the server and renders plain spans: no client JS, no injected HTML. */
export async function Code({
  code,
  lang,
  marks = [],
  numbers = false,
}: {
  code: string;
  lang: BundledLanguage;
  marks?: LineMark[];
  numbers?: boolean;
}) {
  const { tokens } = (await highlighter).codeToTokens(code, { lang, theme: "ponzu" });
  return (
    <code className="code-lines" data-numbers={numbers || undefined}>
      {tokens.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are static and never reorder
        <span key={i} className="code-line" data-mark={marks[i]}>
          {line.map((token, j) => {
            const style: CSSProperties = { color: token.color };
            if (token.fontStyle && token.fontStyle & ITALIC) style.fontStyle = "italic";
            if (token.fontStyle && token.fontStyle & BOLD) style.fontWeight = 600;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens are static and never reorder
              <span key={j} style={style}>
                {token.content}
              </span>
            );
          })}
          {"\n"}
        </span>
      ))}
    </code>
  );
}

/** A unified diff: `+`/`-` prefixes become line marks, the rest is highlighted as `lang`. */
export function Diff({ lines, lang }: { lines: string[]; lang: BundledLanguage }) {
  const marks = lines.map(
    (l): LineMark => (l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined),
  );
  return <Code code={lines.map((l) => l.slice(2)).join("\n")} lang={lang} marks={marks} />;
}

/** A directory tree with the `.design` folder called out. */
export function Tree({ children }: { children: string }) {
  return (
    <code className="code-lines">
      {children.split("\n").map((line) => {
        const [, rail = "", name = ""] = line.match(/^([\s│├└─]*)(.*)$/) ?? [];
        const tone: ReactNode =
          name.endsWith(".design") || name.endsWith(".design/") ? (
            <span className="text-[var(--sh-tag)]">{name}</span>
          ) : name.endsWith("/") || !rail ? (
            <span className="text-[var(--sh-fg)]">{name}</span>
          ) : (
            <span className="text-[var(--sh-comment)]">{name}</span>
          );
        return (
          <span key={line} className="code-line">
            <span className="text-[var(--sh-punct)]">{rail}</span>
            {tone}
            {"\n"}
          </span>
        );
      })}
    </code>
  );
}
