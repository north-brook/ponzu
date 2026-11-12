import { expect, test } from "bun:test";
import { DEV_API_URL, readConfig } from "./config";
import { pickWorkspace, workspaceKey } from "./workspace-rules";

test("Ponzu Dev talks to api.ponzu.design under ponzu-dev://", () => {
  expect(readConfig({ env: {}, variant: "dev", version: "0.12.1" })).toEqual({
    apiUrl: DEV_API_URL,
    workosClientId: "",
    variant: "dev",
    scheme: "ponzu-dev",
    version: "0.12.1",
    appName: "Ponzu Dev",
  });
});

test("production is the default, and the environment names the API and the client id", () => {
  const cfg = readConfig({
    env: {
      EXPO_PUBLIC_PONZU_API_URL: "https://api.example.test/",
      EXPO_PUBLIC_WORKOS_CLIENT_ID: "client_123",
    },
    variant: undefined,
    version: undefined,
  });
  expect(cfg).toMatchObject({
    apiUrl: "https://api.example.test",
    workosClientId: "client_123",
    variant: "production",
    scheme: "ponzu",
    version: "0.0.0",
    appName: "Ponzu",
  });
});

test("the workspace in view: the one picked while it's still theirs, else the first", () => {
  const workspaces = [{ id: "ws_a" }, { id: "ws_b" }];
  expect(pickWorkspace("ws_b", workspaces)).toBe("ws_b");
  expect(pickWorkspace("ws_gone", workspaces)).toBe("ws_a");
  expect(pickWorkspace(null, workspaces)).toBe("ws_a");
  expect(pickWorkspace("ws_a", [])).toBeNull();
  expect(workspaceKey("usr_1")).toBe("ponzu.workspace.usr_1");
});
