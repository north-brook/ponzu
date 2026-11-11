import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveProvider, useLiveQuery, useSessionState } from "./react.ts";
import { createFakeBackend } from "./testing/backend.ts";
import { FakeClock } from "./testing/clock.ts";

function Sidebar({ workspaceId }: { workspaceId: string }) {
  const { rows, status } = useLiveQuery("workspace.designs", { workspaceId });
  return createElement("p", null, `${status}: ${(rows ?? []).map((row) => row.name).join(", ")}`);
}

test("useLiveQuery reads what the query holds, and needs a provider", async () => {
  const clock = new FakeClock();
  const backend = createFakeBackend({ clock });
  const maya = backend.addPerson({ login: "maya" });
  const ws = backend.addWorkspace({ login: "acme", members: { [maya.id]: "admin" } });
  const { api, live } = backend.connect(maya);
  await api.designs.create({ workspaceId: ws.id, name: "Kettle" });
  const render = () =>
    renderToStaticMarkup(
      createElement(LiveProvider, { live }, createElement(Sidebar, { workspaceId: ws.id })),
    );

  expect(render()).toBe("<p>connecting: </p>");
  // Held open elsewhere (a mounted screen), the query's rows reach every reader of it.
  live.subscribe("workspace.designs", { workspaceId: ws.id }, () => {});
  await clock.advance(0);
  expect(render()).toBe("<p>live: Kettle</p>");

  expect(() => renderToStaticMarkup(createElement(Sidebar, { workspaceId: ws.id }))).toThrow(
    "LiveProvider",
  );
});

test("useSessionState reads who is signed in", () => {
  const backend = createFakeBackend();
  const { session } = backend.connect(backend.addPerson({ login: "ines" }));
  function Who() {
    const state = useSessionState(session);
    return createElement("p", null, state.status === "signed_in" ? state.user.githubLogin : "-");
  }
  expect(renderToStaticMarkup(createElement(Who))).toBe("<p>ines</p>");
});
