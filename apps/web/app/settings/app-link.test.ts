import { expect, test } from "bun:test";
import { parseAppLink } from "@ponzu/core/links";
import { appOf } from "../canvases/[id]/app-link";
import { settingsAppLink } from "./app-link";

test("settings open in Ponzu, or in the app the link names", () => {
  expect(settingsAppLink()).toBe("ponzu://settings");
  expect(settingsAppLink("ponzu-dev")).toBe("ponzu-dev://settings");
  expect(settingsAppLink(undefined, { section: "usage", workspace: "ws_1", n: "ntf_1" })).toBe(
    "ponzu://settings?section=usage&workspace=ws_1&n=ntf_1",
  );
  expect(settingsAppLink("ponzu-dev", { section: "notifications" })).toBe(
    "ponzu-dev://settings?section=notifications",
  );
  expect(settingsAppLink(undefined, { section: "account" })).toBe(
    "ponzu://settings?section=account",
  );
  // The page names the app it hands to, as a canvas's page does.
  expect(appOf(settingsAppLink("ponzu-dev"))).toEqual({ name: "Ponzu Dev", release: false });
  expect(appOf(settingsAppLink())).toEqual({ name: "Ponzu", release: true });
});

test("no other scheme can come out of it", () => {
  for (const app of [
    "javascript",
    "https",
    "http://evil.example",
    "ponzu-dev://x",
    "PONZU-DEV",
    // Ponzu Preview predates settings links, so it is not handed one.
    "ponzu-preview",
    ["ponzu-dev"],
    ["ponzu-dev", "ponzu-dev"],
    "",
  ]) {
    expect(settingsAppLink(app, { section: "usage" })).toBe("ponzu://settings?section=usage");
  }
});

test("only the grammar's sections, and only parts that could be ids, ride along", () => {
  for (const section of ["billing", "Usage", "usage ", "", ["usage"], ["usage", "account"]]) {
    expect(settingsAppLink(undefined, { section, workspace: "ws_1" })).toBe(
      "ponzu://settings?workspace=ws_1",
    );
  }
  for (const bad of [
    "ws 1",
    "ws_1&section=account",
    "../ws",
    "ws/1",
    "",
    "x".repeat(65),
    ["ws_1"],
    ["ws_1", "ws_2"],
  ]) {
    expect(settingsAppLink(undefined, { section: "usage", workspace: bad, n: bad })).toBe(
      "ponzu://settings?section=usage",
    );
  }
  expect(settingsAppLink(undefined, { n: "ntf_1" })).toBe("ponzu://settings?n=ntf_1");
});

test("whatever comes in, what goes out is a settings link the apps read back the same", () => {
  const cases: [Parameters<typeof settingsAppLink>[0], Parameters<typeof settingsAppLink>[1]][] = [
    [undefined, {}],
    ["ponzu-dev", { section: "usage", workspace: "ws_1", n: "ntf_1" }],
    ["evil", { section: "<script>", workspace: "a b", n: "%2e%2e" }],
    [["ponzu-dev"], { section: ["usage"], workspace: ["ws_1"], n: ["n"] }],
  ];
  for (const [app, at] of cases) {
    const link = settingsAppLink(app, at);
    const scheme = link.slice(0, link.indexOf("://"));
    const parsed = parseAppLink(link, scheme);
    expect(parsed?.kind).toBe("settings");
  }
  expect(
    parseAppLink(
      settingsAppLink("ponzu-dev", { section: "usage", workspace: "ws_1", n: "ntf_1" }),
      "ponzu-dev",
    ),
  ).toEqual({ kind: "settings", section: "usage", workspaceId: "ws_1", notificationId: "ntf_1" });
});
