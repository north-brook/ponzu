import type { ClientOp } from "@ponzu/core";
import { ApiError } from "./api.ts";
import type { FakeRunnerApi } from "./fake.ts";

/**
 * The fake API behind the runner protocol's routes, as docs/cloud.md writes them down: for
 * testing the HTTP client against the protocol, and for running the runner on a laptop. Bytes
 * are uploaded to `/uploads/<id>` on the same server.
 */
export function fakeApiHandler(
  fake: FakeRunnerApi,
  opts: { designId: string; token: string },
): (request: Request) => Promise<Response> {
  const pending = new Map<string, { purpose: string; name: string; contentType: string }>();
  let uploads = 0;
  const design = `/v1/designs/${opts.designId}`;

  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route.startsWith("PUT /uploads/")) {
        const id = url.pathname.slice("/uploads/".length);
        const file = pending.get(id);
        if (!file) return new Response(null, { status: 404 });
        fake.uploads.push({ ...file, purpose: file.purpose as never, bytes: await bytes(request) });
        return new Response(null, { status: 200 });
      }
      if (request.headers.get("authorization") !== `Bearer ${opts.token}`)
        throw new ApiError(401, "token_invalid", "This runner token is not valid.");
      const body = request.method === "GET" ? undefined : ((await request.json()) as any);
      switch (route) {
        case "GET /v1/runner/session":
          return Response.json(await fake.session());
        case "POST /v1/runner/events/claim":
          return Response.json(await fake.claim(body));
        case "POST /v1/runner/events/ack":
          await fake.ack(body.ids);
          return Response.json({ acked: body.ids.length });
        case "POST /v1/runner/thread":
          return Response.json(await fake.writeThread(body.items));
        case "PUT /v1/runner/state":
          return Response.json(await fake.putState(body));
        case "POST /v1/runner/questions":
          await fake.ask(body);
          return Response.json({ id: body.id, status: fake.questions.get(body.id)?.status });
        case "POST /v1/runner/questions/withdraw":
          await fake.withdraw(body.ids);
          return Response.json({ withdrawn: body.ids.length });
        case "POST /v1/runner/uploads":
          return Response.json({
            files: body.files.map((f: { purpose: string; name: string; contentType: string }) => {
              const id = `up_${++uploads}`;
              pending.set(id, f);
              return {
                id,
                put: {
                  url: `${url.origin}/uploads/${id}`,
                  headers: { "content-type": f.contentType },
                },
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
              };
            }),
          });
        case "POST /v1/runner/uploads/complete":
          return Response.json({
            files: body.ids.map((id: string) => {
              const file = pending.get(id)!;
              const asset = file.purpose === "asset";
              return {
                id,
                ref: asset ? `assets/${file.name}` : null,
                url: `${fake.sessionInfo.assetBase}/${asset ? "" : `${file.purpose}s/`}${file.name}`,
              };
            }),
          });
        case "POST /v1/runner/git-credential":
          return Response.json(await fake.gitCredential(body));
        case "POST /v1/runner/git-credential/erase":
          await fake.eraseGitCredential(body);
          return new Response(null, { status: 204 });
        case "POST /v1/runner/usage":
          await fake.recordUsage(body.turns);
          return Response.json({ recorded: body.turns.length });
        case `POST ${design}/ops`:
          return Response.json(await fake.sync.commit(body.ops as ClientOp[]));
        case `GET ${design}/ops`: {
          const ops = await fake.sync.fetchOps(Number(url.searchParams.get("after")));
          if (ops === "gone") throw new ApiError(410, "gone", "Those ops are no longer kept.");
          return Response.json(ops);
        }
        case `GET ${design}/doc`:
          return Response.json(await fake.sync.fetchDoc());
      }
      throw new ApiError(404, "not_found", "There is nothing at this address.");
    } catch (err) {
      const e =
        err instanceof ApiError ? err : new ApiError(503, "upstream_unavailable", String(err));
      return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
  };
}

async function bytes(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}
