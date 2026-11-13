#!/usr/bin/env bun
/**
 * Prints one fixture's subject, preview and text part, or its HTML with --html.
 *
 *   bun packages/email/scripts/print.ts digest-two [--html]
 */
import { FIXTURES } from "../src/fixtures.ts";
import { renderEmail } from "../src/render.ts";

const [name, flag] = process.argv.slice(2);
const fixture = name ? FIXTURES[name] : undefined;
if (!fixture) {
  console.error(`Name one of: ${Object.keys(FIXTURES).join(", ")}`);
  process.exit(1);
}
const email = await renderEmail(fixture.kind, fixture.props as never);
if (flag === "--html") console.log(email.html);
else console.log(`Subject: ${email.subject}\nPreview: ${email.preview}\n\n${email.text}`);
