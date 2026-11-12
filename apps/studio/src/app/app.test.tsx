import { expect, test } from "bun:test";
import type { Session, SessionState } from "@ponzu/client";
import { createFakeBackend } from "@ponzu/client/testing";
import type { UpdateState } from "@ponzu/desktop/bridge";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./app.tsx";
import type { Host } from "./host.ts";
import { UpdateNotes } from "./update.tsx";

/** A host on the in-memory backend whose session is in `state`. */
function hostIn(state: SessionState): Host {
  const backend = createFakeBackend();
  const maya = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const client = backend.connect(maya);
  const session: Session = { ...client.session, getState: () => state };
  const ready: UpdateState = {
    version: "2.0.0",
    canUpdate: true,
    ready: { version: "2.1.0", notes: ["Faster boards."] },
    installing: false,
  };
  return {
    session,
    api: client.api,
    live: client.live,
    lights: "drawn",
    signIn: async () => ({ ok: true }),
    persistence: async () => "keychain",
    onLink: () => () => {},
    installGithub: async () => {},
    onCommand: () => () => {},
    update: {
      state: async () => ready,
      onState: () => () => {},
      check() {},
      install() {},
    },
    openExternal() {},
    docStorage: null,
    notifications: null,
  };
}

const user = { id: "usr_1", githubLogin: "maya", name: "Maya", email: null, avatarUrl: null };

test("signed out, the window is the sign-in screen and nothing else", () => {
  const html = renderToStaticMarkup(<App host={hostIn({ status: "signed_out" })} />);
  expect(html).toContain('data-screen="sign-in"');
  expect(html).toContain("Sign in to Ponzu");
  expect(html).toContain("Continue with GitHub");
  expect(html).not.toContain('id="sidebar"');
});

test("GitHub wanting Ponzu let in again asks to sign in again, saying why", () => {
  const html = renderToStaticMarkup(<App host={hostIn({ status: "github_reauth" })} />);
  expect(html).toContain("Sign in again");
  expect(html).toContain("GitHub needs you to let Ponzu in again");
});

test("a build the API turns away shows the update, whoever is signed in", () => {
  const html = renderToStaticMarkup(
    <App host={hostIn({ status: "too_old", minimumVersion: "2.1.0" })} />,
  );
  expect(html).toContain('data-screen="update"');
  expect(html).toContain("Ponzu needs an update");
  expect(html).not.toContain('data-screen="sign-in"');
});

test("while the session is read, nothing is shown that could flash and go", () => {
  const html = renderToStaticMarkup(<App host={hostIn({ status: "loading" })} />);
  expect(html).not.toContain("data-screen");
});

test("signed in, the main window takes over", () => {
  const html = renderToStaticMarkup(<App host={hostIn({ status: "signed_in", user })} />);
  expect(html).not.toContain('data-screen="sign-in"');
  // The window's chrome, with no lockup in it (README, "The window chrome").
  expect(html).toContain("<header");
  expect(html).not.toContain(">ponzu<");
});

test("the update's notes, and Restart while it isn't already restarting", () => {
  const notes = (installing: boolean) =>
    renderToStaticMarkup(
      <UpdateNotes
        version="2.1.0"
        notes={["Boards draw faster.", "Comments keep their place."]}
        installing={installing}
        onRestart={() => {}}
        onLater={() => {}}
      />,
    );
  expect(notes(false)).toContain("Ponzu 2.1.0");
  expect(notes(false)).toContain("<li>Boards draw faster.</li>");
  expect(notes(false)).toContain(">Restart<");
  expect(notes(true)).toContain("Restarting…");
});
