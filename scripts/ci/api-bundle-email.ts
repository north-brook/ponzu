/*
 * The entry scripts/ci/api-bundle.ts bundles the way the API is bundled and runs in Node: it
 * renders the digest fixture through @ponzu/email and prints what it got, so the check sees
 * react-email's render work inside a Node bundle, not only under Bun's own loader.
 */
import { FIXTURES } from "../../packages/email/src/fixtures.ts";
import { renderEmail } from "../../packages/email/src/render.ts";

const fixture = FIXTURES["digest-two"];
if (fixture?.kind !== "digest") throw new Error("The digest-two fixture is missing.");
const email = await renderEmail("digest", fixture.props);
console.log(
  JSON.stringify({ subject: email.subject, html: email.html, node: process.versions.node }),
);
