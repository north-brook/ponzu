import { expect, test } from "bun:test";
import { hc } from "hono/client";
import { createTestApp } from "./testing/index.ts";
import type { AppType } from "./types.ts";

// The typed client is the next step's to build. This holds the door open for it: if the
// routes stop reaching `AppType` (a sub-app mounted without chaining, a handler that returns
// an untyped Response), this file stops compiling.
test("AppType carries each route's request and response to a typed client", async () => {
  const t = await createTestApp();
  const api = hc<AppType>("http://api.test", {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => t.app.request(String(input), init),
  });
  const started = await t.startSignIn({ login: "maya" });

  const exchanged = await api.v1.auth.exchange.$post({
    json: { code: started.code, code_verifier: started.codeVerifier },
  });
  expect(exchanged.status).toBe(200);
  const session = await exchanged.json();
  const login: string = session.user.githubLogin;
  expect(login).toBe("maya");

  const me = await api.v1.me.$get(
    {},
    { headers: { authorization: `Bearer ${session.access_token}` } },
  );
  const { workspaces, claudeAccount, onboarding } = await me.json();
  const roles: ("admin" | "member")[] = workspaces.map((workspace) => workspace.role);
  // A date arrives as the string JSON made of it.
  const confirmed: string | null = onboarding.whereConfirmedAt;
  expect([roles, claudeAccount, confirmed]).toEqual([[], null, null]);

  const health = await api.v1.health.$get();
  const { database }: { database: boolean } = await health.json();
  expect(database).toBe(true);
  await t.close();
});
