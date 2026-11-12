import { Tick02Icon } from "@hugeicons/core-free-icons";
import {
  type ComponentProps,
  isValidElement,
  type MouseEvent,
  memo,
  type ReactElement,
  type ReactNode,
  useMemo,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import { parseCanvasAddress } from "./canvas-address.ts";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";
import { parts, prepare, remarkGfm, remarkUntrusted, safeHref, settled } from "./markdown.ts";
import { PlaceLink } from "./place-link.tsx";

/**
 * Markdown from the agent or GitHub, drawn with react-markdown into our own elements and tokens.
 * Nothing it holds is ever read as markup (markdown.ts has the rules). Links leave the app
 * through `onOpenLink`; without it they open a new window, which the desktop shell hands to the
 * browser. Memoized twice: a line of the thread redraws only when its text changes (so
 * `onOpenLink` should keep its identity), and within it each run of blocks (markdown.ts's
 * `blocks` and `runs`) only when its own text does, so a reply streaming in parses and redraws
 * only its last run. While `streaming`, a link still being written at the end reads as its words
 * alone, never as half of its syntax.
 */
export const Prose = memo(function Prose({
  text,
  streaming = false,
  onOpenLink,
  className,
}: {
  text: string;
  streaming?: boolean;
  onOpenLink?: (url: string) => void;
  className?: string;
}) {
  const components = useMemo(() => elements(onOpenLink), [onOpenLink]);
  const source = useMemo(
    () => (streaming ? settled(prepare(text)) : prepare(text)),
    [text, streaming],
  );
  const runs = useMemo(() => parts(source), [source]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 [overflow-wrap:anywhere]", className)}>
      {runs ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity but their place
        runs.map((run, i) => <Block key={i} source={run} components={components} />)
      ) : (
        <p dir="auto" className="m-0 whitespace-pre-wrap">
          {source}
        </p>
      )}
    </div>
  );
});

const PLUGINS = [remarkGfm, remarkBreaks, remarkUntrusted];
const safeUrl = (url: string) => safeHref(url) ?? undefined;

const Block = memo(function Block({
  source,
  components,
}: {
  source: string;
  components: Components;
}) {
  return (
    <Markdown
      remarkPlugins={PLUGINS}
      urlTransform={safeUrl}
      disallowedElements={["img"]}
      components={components}
    >
      {source}
    </Markdown>
  );
});

const linkClass =
  "rounded-2 text-ink underline decoration-dry underline-offset-2 outline-none transition-[text-decoration-color] duration-(--dur-hover) focus-ring hover:decoration-current";

/** Our elements for each of Markdown's. `node` is react-markdown's tree, never drawn. */
function elements(onOpenLink?: (url: string) => void): Components {
  const heading = ({ children }: { children?: ReactNode }) => (
    <p dir="auto" className="m-0 font-semibold text-ink">
      {children}
    </p>
  );
  return {
    p: ({ children }) => (
      <p dir="auto" className="m-0">
        {children}
      </p>
    ),
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    ul: ({ children, className }) => (
      <ul
        className={cn(
          "m-0 flex flex-col gap-0.5 pl-[18px] marker:text-faint",
          className?.includes("contains-task-list") ? "list-none pl-0.5" : "list-disc",
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ children, start }) => (
      <ol
        start={start}
        className="m-0 flex list-decimal flex-col gap-0.5 pl-[18px] marker:text-faint"
      >
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li dir="auto" className="pl-0.5">
        {children}
      </li>
    ),
    // A task list's box: drawn, never a control (GitHub's are disabled too).
    input: ({ type, checked }) =>
      type === "checkbox" ? (
        <span
          role="img"
          aria-label={checked ? "Done" : "Not done"}
          className={cn(
            "mr-1.5 inline-grid size-[13px] place-items-center rounded-3 align-[-2px]",
            checked ? "bg-action text-action-ink" : "shadow-[inset_0_0_0_1px_var(--c-faint)]",
          )}
        >
          {checked ? <Icon icon={Tick02Icon} step="tick" onFill /> : null}
        </span>
      ) : null,
    // Fenced code: the text alone in a box that scrolls sideways, so a long line never widens the
    // thread.
    pre: ({ children }) => (
      <pre className="m-0 min-w-0 overflow-x-auto rounded-8 bg-hover px-3 py-2 font-mono text-12 leading-[1.6] [overflow-wrap:normal] [scrollbar-width:thin]">
        {codeText(children)}
      </pre>
    ),
    code: ({ children }) => <code className="font-mono text-[0.923em]">{children}</code>,
    blockquote: ({ children }) => (
      <blockquote
        dir="auto"
        className="m-0 flex flex-col gap-2 border-rule border-l-2 pl-3 text-muted"
      >
        {children}
      </blockquote>
    ),
    hr: () => <hr className="m-0 h-px border-0 bg-rule" />,
    strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    del: ({ children }) => <del>{children}</del>,
    a: ({ href, children }) => {
      // An address that wasn't safe arrives without one: its words stay, as text.
      if (!href) return <>{children}</>;
      const open = onOpenLink
        ? (e: MouseEvent) => {
            e.preventDefault();
            onOpenLink(href);
          }
        : undefined;
      const external = (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={open}
          className={linkClass}
        >
          {children}
        </a>
      );
      // A design's own address, a page or board of it: followed in place where a design is open.
      const address = parseCanvasAddress(href);
      return address ? (
        <PlaceLink address={address} href={href} external={external}>
          {children}
        </PlaceLink>
      ) : (
        external
      );
    },
    // A table scrolls sideways inside its own box rather than widening what holds it.
    table: ({ children }) => (
      <div className="min-w-0 overflow-x-auto [scrollbar-width:thin]">
        <table className="border-collapse text-12">{children}</table>
      </div>
    ),
    th: ({ children, style }) => (
      <th
        dir="auto"
        style={align(style)}
        className="border-rule border-b px-2 py-1 text-left font-semibold text-ink first:pl-0"
      >
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td dir="auto" style={align(style)} className="border-rule border-b px-2 py-1 first:pl-0">
        {children}
      </td>
    ),
  };
}

/** A column's alignment, which GFM writes as a style; nothing else of a style survives. */
function align(style: ComponentProps<"td">["style"]) {
  return style?.textAlign ? { textAlign: style.textAlign } : undefined;
}

/** A fenced block's text, out of the `<code>` react-markdown wraps it in, less its last line end. */
function codeText(children: ReactNode): ReactNode {
  const code = Array.isArray(children) ? children[0] : children;
  const text = isValidElement(code)
    ? (code as ReactElement<{ children?: ReactNode }>).props.children
    : children;
  return typeof text === "string" ? text.replace(/\n$/, "") : text;
}
