import type { ComponentProps, ReactNode } from "react";

/*
 * The site's long-form text: the column, its headings, paragraphs, links, code, lists and tables.
 * The privacy page writes with these, and MDX pages get them through mdx-components.tsx, so a page
 * written in either reads the same.
 */

/**
 * The text column: 640px, 16/27 type, 16px between blocks and 48px before each part. A part is a
 * <Section> in TSX; MDX has no sections, only a flat run of blocks, so there a `##` heading opens
 * the part instead. Both come out the same.
 */
export function Prose({ children }: { children: ReactNode }) {
  return (
    <article className="mx-auto flex max-w-[640px] flex-col gap-4 text-[16px]/[27px] text-pretty text-muted [&>h2:not(:first-child)]:mt-8 [&>section+section]:mt-8">
      {children}
    </article>
  );
}

/** A titled part of the column. In MDX, a `##` heading and what follows it. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 [&_p]:m-0">
      <H2>{title}</H2>
      {children}
    </section>
  );
}

export function H2(props: ComponentProps<"h2">) {
  return (
    <h2 className="m-0 text-[22px]/[30px] font-semibold tracking-[-0.01em] text-ink" {...props} />
  );
}

export function P(props: ComponentProps<"p">) {
  return <p className="m-0" {...props} />;
}

export function Link({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      className="text-ink underline decoration-outline underline-offset-4 hover:decoration-ink"
      href={href}
    >
      {children}
    </a>
  );
}

export function Code({ children }: { children?: ReactNode }) {
  return (
    <code className="rounded bg-chip px-1.5 py-0.5 font-mono text-[14px] text-ink">{children}</code>
  );
}

export function Ul(props: ComponentProps<"ul">) {
  return <ul className="m-0 flex list-disc flex-col gap-2 pl-5 marker:text-faint" {...props} />;
}

export function Table(props: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[15px]/6" {...props} />
    </div>
  );
}

export function Th(props: ComponentProps<"th">) {
  return <th className="border-b border-rule py-2 pr-4 font-medium text-ink" {...props} />;
}

export function Td(props: ComponentProps<"td">) {
  return <td className="border-b border-rule py-2 pr-4 align-top" {...props} />;
}
