import { createHash } from "node:crypto";
import type { ClientOp } from "@ponzu/core";
import { ApiError } from "./api.ts";
import type { FakeRunnerApi } from "./fake.ts";
import { RUNNER_HEADER } from "./protocol.ts";

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
  /** A checkpoint's archives, by upload id, until the checkpoint names them. */
  const archives = new Map<string, Uint8Array>();
  /** What `/v1/runner/restore` hands out, by download id. */
  const downloads = new Map<string, Uint8Array>();
  let uploads = 0;
  const design = `/v1/designs/${opts.designId}`;
  const archive = (purpose: string) => purpose === "session" || purpose === "workspace";

  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route.startsWith("PUT /uploads/")) {
        const id = url.pathname.slice("/uploads/".length);
        const file = pending.get(id);
        if (!file) return new Response(null, { status: 404 });
        const body = await bytes(request);
        if (archive(file.purpose)) archives.set(id, body);
        else fake.uploads.push({ ...file, purpose: file.purpose as never, bytes: body });
        return new Response(null, { status: 200 });
      }
      if (route.startsWith("GET /downloads/")) {
        const found = downloads.get(url.pathname.slice("/downloads/".length));
        return found
          ? new Response(Buffer.from(found), { headers: { "content-type": "application/gzip" } })
          : new Response(null, { status: 404 });
      }
      if (request.headers.get("authorization") !== `Bearer ${opts.token}`)
        throw new ApiError(401, "token_invalid", "This runner token is not valid.");
      const runner = request.headers.get(RUNNER_HEADER) ?? "";
      const body = request.method === "GET" ? undefined : ((await request.json()) as any);
      switch (route) {
        case "POST /v1/runner/session":
          return Response.json(await fake.session());
        case "POST /v1/runner/events/claim":
          return Response.json(await fake.claim(runner, body));
        case "POST /v1/runner/events/ack":
          await fake.ack(runner, body.ids, body.claudeSessionId);
          return Response.json({ acked: body.ids.length });
        case "POST /v1/runner/thread":
          return Response.json(await fake.writeThread(runner, body.items));
        case "PUT /v1/runner/state":
          return Response.json(await fake.putState(runner, body));
        case "POST /v1/runner/questions":
          await fake.ask(runner, body);
          return Response.json({ id: body.id, status: fake.questions.get(body.id)?.status });
        case "POST /v1/runner/questions/withdraw":
          await fake.withdraw(runner, body.ids);
          return Response.json({ withdrawn: body.ids.length });
        case "POST /v1/runner/uploads":
          // Asking for addresses is a call like the rest; the bytes are counted when they land.
          await fake.upload(runner, []);
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
          await fake.upload(runner, []);
          return Response.json({
            files: body.ids.map((id: string) => {
              const file = pending.get(id);
              if (!file) throw new ApiError(404, "not_found", "Those bytes never arrived.");
              const { ref, url } = fake.placed(file);
              return { id, ref, url };
            }),
          });
        case "POST /v1/runner/git-credential":
          return Response.json(await fake.gitCredential(runner, body));
        case "POST /v1/runner/git-credential/erase":
          await fake.eraseGitCredential(runner, body);
          return new Response(null, { status: 204 });
        case "POST /v1/runner/git-report":
          await fake.reportGit(runner, body);
          return new Response(null, { status: 204 });
        case "POST /v1/runner/usage":
          await fake.recordUsage(runner, body.turns);
          return Response.json({ recorded: body.turns.length });
        case "POST /v1/runner/checkpoint": {
          const take = (id: string | null) => {
            if (id === null) return null;
            const found = archives.get(id);
            if (!found) throw new ApiError(404, "not_found", "Those bytes never arrived.");
            return found;
          };
          const saved = await fake.saveCheckpoint(runner, {
            turn: body.turn,
            claudeSessionId: body.claudeSessionId,
            wipCommit: body.wipCommit,
            session: take(body.session),
            workspace: take(body.workspace),
          });
          return Response.json({ saved });
        }
        case "POST /v1/runner/restore": {
          const restored = await fake.restore(runner);
          const offer = (found: Uint8Array | null) => {
            if (!found) return null;
            const id = `dl_${++uploads}`;
            downloads.set(id, found);
            return {
              url: `${url.origin}/downloads/${id}`,
              size: found.byteLength,
              sha256: createHash("sha256").update(found).digest("hex"),
            };
          };
          return Response.json({
            saved: restored.saved,
            session: offer(restored.session),
            workspace: offer(restored.workspace),
          });
        }
        case "POST /v1/runner/restored":
          await fake.reportRestored(runner, body);
          return new Response(null, { status: 204 });
        case "POST /v1/runner/pull-request-summary":
          return Response.json(await fake.pullRequestSummary(runner, body.summary));
        case "GET /v1/runner/pull-request":
          return Response.json(await fake.readPullRequest(runner, url.searchParams.get("turn")));
        case "POST /v1/runner/pull-request/open":
        case "POST /v1/runner/pull-request/ready":
        case "POST /v1/runner/pull-request/auto-merge":
        case "POST /v1/runner/pull-request/update-branch":
        case "POST /v1/runner/pull-request/merge": {
          const action = url.pathname.slice("/v1/runner/pull-request/".length).replace("-", "_");
          return Response.json(await fake.actOnPullRequest(runner, action as never, body));
        }
        case `POST ${design}/ops`:
          return Response.json(await fake.commit(runner, body.ops as ClientOp[]));
        case `GET ${design}/ops`: {
          const ops = await fake.fetchOps(runner, Number(url.searchParams.get("after")));
          if (ops === "gone") throw new ApiError(410, "gone", "Those ops are no longer kept.");
          return Response.json(ops);
        }
        case `GET ${design}/doc`:
          return Response.json(await fake.fetchDoc(runner));
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
