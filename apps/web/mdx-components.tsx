import type { MDXComponents } from "mdx/types";
import { Li } from "@/components/legal";
import { Code, H1, H2, H3, Link, Ol, P, Pre, Strong, Table, Td, Th, Ul } from "@/components/prose";

/*
 * What an .mdx page's Markdown renders as: the site's prose (components/prose.tsx), the same text
 * the privacy page sets in TSX. @next/mdx requires this file at the site's root for the App
 * Router. A page wraps its MDX in <Prose> (its layout) for the column.
 */

export const components: MDXComponents = {
  h1: H1,
  h2: H2,
  h3: H3,
  p: P,
  a: Link,
  strong: Strong,
  code: Code,
  ul: Ul,
  ol: Ol,
  li: Li,
  pre: Pre,
  table: Table,
  th: Th,
  td: Td,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
