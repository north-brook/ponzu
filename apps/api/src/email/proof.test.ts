import { expect, test } from "bun:test";
import { FIXTURES } from "@ponzu/email/fixtures";
import { noMail } from "../deps/mail.ts";
import { FakeMail } from "../testing/fake-mail.ts";
import { PROOF_SUBJECT_PREFIX, proofRefusal, sendProofs } from "./proof.ts";

const ok = {
  environment: "dev",
  allow: "founder@example.com, @northbrook.dev",
  to: "founder@example.com",
  replyTo: "hello@ponzu.design",
};

test("the proof refuses production, no key, no allowlist, and an address it does not name", () => {
  const on = new FakeMail();
  expect(proofRefusal(ok, on)).toBeNull();
  expect(proofRefusal({ ...ok, to: "x@northbrook.dev" }, on)).toBeNull();
  expect(proofRefusal({ ...ok, environment: "production" }, on)).toContain("production");
  expect(proofRefusal(ok, noMail)).toContain("RESEND_API_KEY");
  expect(proofRefusal({ ...ok, to: undefined }, on)).toContain("--to");
  expect(proofRefusal({ ...ok, allow: undefined }, on)).toContain("PONZU_EMAIL_ALLOW is not set");
  expect(proofRefusal({ ...ok, allow: "nope" }, on)).toContain("malformed");
  expect(proofRefusal({ ...ok, to: "stranger@example.com" }, on)).toContain("not one");
  // No refusal quotes the address.
  expect(proofRefusal({ ...ok, to: "stranger@example.com" }, on)).not.toContain("stranger");
});

test("the proof sends every sample once, marked, through the seam", async () => {
  const mail = new FakeMail();
  const results = await sendProofs(mail, { ...ok, to: ok.to, environment: "dev" }, { run: "r1" });
  const names = Object.keys(FIXTURES);
  expect(results.map((r) => r.name)).toEqual(names);
  expect(results.every((r) => r.outcome.startsWith("sent eml_"))).toBe(true);
  expect(mail.sent).toHaveLength(names.length);
  for (const email of mail.sent) {
    expect(email.to).toBe(ok.to);
    expect(email.subject.startsWith(PROOF_SUBJECT_PREFIX)).toBe(true);
    expect(email.replyTo).toBe("hello@ponzu.design");
    expect(email.idempotencyKey).toStartWith("proof/r1/");
  }
  // Running again in the same run sends nothing more; `--only` sends one.
  await sendProofs(mail, { ...ok, to: ok.to, environment: "dev" }, { run: "r1" });
  expect(mail.sent).toHaveLength(names.length);
  const one = await sendProofs(
    mail,
    { ...ok, to: ok.to, environment: "dev" },
    { run: "r2", only: ["digest-one"] },
  );
  expect(one).toEqual([{ name: "digest-one", outcome: expect.stringMatching(/^sent /) }]);
});
