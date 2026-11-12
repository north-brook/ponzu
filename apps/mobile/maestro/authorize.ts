#!/usr/bin/env bun
/**
 * The fake backend's authorize page, standing in for WorkOS's in the Maestro run: it answers
 * `GET /authorize?redirect_uri=…&state=…` by sending the browser straight back to the app with
 * `code=fake` (the only code the fake backend takes) and the sign-in's own state. The app's real
 * auth session (ASWebAuthenticationSession) opens it, so its plumbing runs with no account.
 *
 *   bun apps/mobile/maestro/authorize.ts <port>
 *
 * Only Ponzu Dev's scheme is redirected to; anything else is refused.
 */

const port = Number(process.argv[2] ?? 0);

export function redirectFor(url: URL): string | null {
  if (url.pathname !== "/authorize") return null;
  const redirect = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  if (!redirect?.startsWith("ponzu-dev://auth/callback") || !state) return null;
  return `${redirect}?code=fake&state=${encodeURIComponent(state)}`;
}

if (import.meta.main) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      const to = redirectFor(url);
      return to
        ? new Response(null, { status: 302, headers: { Location: to } })
        : new Response("Not a sign-in this page answers.", { status: 400 });
    },
  });
  console.log(`authorize page on ${server.url}`);
}
