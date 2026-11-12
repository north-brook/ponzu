import type { MDXComponents } from "mdx/types";
import { Code, H2, Link, Ol, P, Pre, Table, Td, Th, Ul } from "@/components/prose";

/*
 * What an .mdx page's Markdown renders as: the site's prose (components/prose.tsx), the same text
 * the privacy page sets in TSX. @next/mdx requires this file at the site's root for the App
 * Router. A page wraps its MDX in <Prose> (its layout) for the column.
 */

const components: MDXComponents = {
  h2: H2,
  p: P,
  a: Link,
  code: Code,
  ul: Ul,
  ol: Ol,
  pre: Pre,
  table: Table,
  th: Th,
  td: Td,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
