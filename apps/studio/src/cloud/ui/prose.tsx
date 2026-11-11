import { type MouseEvent, type ReactNode, useMemo } from "react";
import { cn } from "./cn.ts";
import { type Block, type Inline, parseMarkdown } from "./markdown.ts";

/**
 * Markdown from the agent or GitHub, drawn as text. Everything it holds becomes React text and a
 * handful of elements (markdown.ts decides which), so no string from it is ever read as markup.
 * Links leave the app through `onOpenLink`; without it they open a new window, which the desktop
 * shell hands to the browser.
 */
export function Prose({
  text,
  onOpenLink,
  className,
}: {
  text: string;
  onOpenLink?: (url: string) => void;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 [overflow-wrap:anywhere]", className)}>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity but their place
        <BlockView key={i} block={block} onOpenLink={onOpenLink} />
      ))}
    </div>
  );
}

function BlockView({ block, onOpenLink }: { block: Block; onOpenLink?: (url: string) => void }) {
  const inline = (children: Inline[]) => <InlineView nodes={children} onOpenLink={onOpenLink} />;
  switch (block.kind) {
    case "paragraph":
      return <p className="m-0">{inline(block.children)}</p>;
    case "heading":
      return <p className="m-0 font-semibold text-ink">{inline(block.children)}</p>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={cn(
            "m-0 flex flex-col gap-0.5 pl-[18px] marker:text-faint",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity but their place
            <li key={i} className="pl-0.5">
              {inline(item)}
            </li>
          ))}
        </List>
      );
    }
    case "code":
      return (
        <pre className="m-0 overflow-x-auto rounded-8 bg-hover px-3 py-2 font-mono text-12 leading-[1.6] [scrollbar-width:thin]">
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote className="m-0 flex flex-col gap-2 border-rule border-l-2 pl-3 text-muted">
          {block.children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity but their place
            <BlockView key={i} block={child} onOpenLink={onOpenLink} />
          ))}
        </blockquote>
      );
    case "rule":
      return <hr className="m-0 h-px border-0 bg-rule" />;
  }
}

function InlineView({
  nodes,
  onOpenLink,
}: {
  nodes: Inline[];
  onOpenLink?: (url: string) => void;
}): ReactNode {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "break":
        // biome-ignore lint/suspicious/noArrayIndexKey: inline runs have no identity but their place
        return <br key={i} />;
      case "code":
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs have no identity but their place
          <code key={i} className="font-mono text-[0.923em]">
            {node.text}
          </code>
        );
      case "strong":
      case "em":
      case "del": {
        const Tag = node.kind === "strong" ? "strong" : node.kind;
        return (
          <Tag
            // biome-ignore lint/suspicious/noArrayIndexKey: inline runs have no identity but their place
            key={i}
            className={node.kind === "strong" ? "font-semibold text-ink" : undefined}
          >
            <InlineView nodes={node.children} onOpenLink={onOpenLink} />
          </Tag>
        );
      }
      case "link": {
        const open = onOpenLink
          ? (e: MouseEvent) => {
              e.preventDefault();
              onOpenLink(node.href);
            }
          : undefined;
        return (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: inline runs have no identity but their place
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={open}
            className="rounded-2 text-ink underline decoration-dry underline-offset-2 outline-none transition-[text-decoration-color] duration-(--dur-hover) focus-ring hover:decoration-current"
          >
            <InlineView nodes={node.children} onOpenLink={onOpenLink} />
          </a>
        );
      }
    }
  });
}
