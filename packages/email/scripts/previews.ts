#!/usr/bin/env bun
/**
 * Writes emails/<fixture>.tsx, the preview server's entries (`bun run preview`), one for each
 * fixture: a default export that draws the template, with the fixture as its PreviewProps.
 * Run it again after adding a fixture.
 *
 *   bun packages/email/scripts/previews.ts
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXTURES } from "../src/fixtures.ts";

const TEMPLATES = {
  billing: ["billing", "BillingEmail", "BillingProps"],
  team: ["members", "MembersEmail", "MembersProps"],
  recap: ["recap", "RecapEmail", "RecapProps"],
  digest: ["digest", "DigestEmail", "DigestProps"],
  notice: ["notice", "NoticeEmail", "NoticeProps"],
} as const;

const dir = resolve(import.meta.dir, "../emails");
mkdirSync(dir, { recursive: true });
for (const file of readdirSync(dir)) rmSync(join(dir, file));
for (const [name, { kind }] of Object.entries(FIXTURES)) {
  const [file, component, props] = TEMPLATES[kind];
  writeFileSync(
    join(dir, `${name}.tsx`),
    [
      'import { FIXTURES } from "../src/fixtures.ts";',
      `import { ${component}, type ${props} } from "../src/templates/${file}.tsx";`,
      "",
      `/** The \`${name}\` fixture, for \`bun run preview\` (written by scripts/previews.ts). */`,
      `export default function Preview(props: ${props}) {`,
      `  return <${component} {...props} />;`,
      "}",
      `Preview.PreviewProps = FIXTURES["${name}"]!.props as ${props};`,
      "",
    ].join("\n"),
  );
}
console.log(`Wrote ${Object.keys(FIXTURES).length} preview entries.`);
