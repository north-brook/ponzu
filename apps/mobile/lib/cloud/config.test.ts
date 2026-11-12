import { expect, test } from "bun:test";
import { apiUrlOf, DEV_API_URL, readConfig } from "./config";
import { pickWorkspace, workspaceKey } from "./workspace-rules";

test("Ponzu Dev talks to api-dev.ponzu.design under ponzu-dev://", () => {
  expect(DEV_API_URL).toBe("https://api-dev.ponzu.design");
  expect(apiUrlOf(readConfig({ env: {}, variant: "dev", version: "1.0.0" }))).toBe(DEV_API_URL);
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

test("a production build that names no API is an error, never dev by omission", () => {
  for (const url of [undefined, "", "  "]) {
    const cfg = readConfig({
      env: { EXPO_PUBLIC_PONZU_API_URL: url },
      variant: "production",
      version: "1.0.0",
    });
    expect(cfg.apiUrl).toBe("");
    expect(() => apiUrlOf(cfg)).toThrow("EXPO_PUBLIC_PONZU_API_URL is empty");
  }
  // No variant at all is production too, as a store build must be.
  expect(() => apiUrlOf(readConfig({ env: {}, variant: undefined, version: "1.0.0" }))).toThrow();
});

test("the workspace in view: the one picked while it's still theirs, else the first", () => {
  const workspaces = [{ id: "ws_a" }, { id: "ws_b" }];
  expect(pickWorkspace("ws_b", workspaces)).toBe("ws_b");
  expect(pickWorkspace("ws_gone", workspaces)).toBe("ws_a");
  expect(pickWorkspace(null, workspaces)).toBe("ws_a");
  expect(pickWorkspace("ws_a", [])).toBeNull();
  expect(workspaceKey("usr_1")).toBe("ponzu.workspace.usr_1");
});
