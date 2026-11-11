import { expect, test } from "bun:test";
import { scrubSecrets, scrubSecretsText } from "./telemetry-scrub.ts";

test("a URL in any text keeps its origin and path, never its query or fragment", () => {
  expect(scrubSecretsText("Couldn't open ponzu://auth?code=abc123&state=xyz")).toBe(
    "Couldn't open ponzu://auth",
  );
  expect(
    scrubSecretsText(
      "fetch failed: https://uploads.example/k/a.png?X-Amz-Signature=s3cr3t#x (500)",
    ),
  ).toBe("fetch failed: https://uploads.example/k/a.png (500)");
  expect(scrubSecretsText("at https://api.ponzu.design/v1/me")).toBe(
    "at https://api.ponzu.design/v1/me",
  );
});

test("credential-shaped text is replaced wherever it is", () => {
  expect(scrubSecretsText("callback with code=abc123 refused")).toBe(
    "callback with code=[redacted] refused",
  );
  expect(scrubSecretsText("Authorization: Bearer eyJabc.def")).toBe("Authorization: [redacted]");
  expect(scrubSecretsText("token ghp_0123456789abcdefABCD leaked")).toBe("token [redacted] leaked");
  expect(scrubSecretsText("key sk-ant-oat01-abcdefghijkl")).toBe("key [redacted]");
  // What isn't a secret stays, the project's own public key included.
  expect(scrubSecretsText("phc_project_key")).toBe("phc_project_key");
});

test("every string in an event, however deep, is scrubbed; the rest is left as it was", () => {
  const event = {
    event: "$exception",
    properties: {
      token: "phc_project_key",
      design_id: "dsn_1",
      count: 3,
      $exception_list: [
        {
          type: "Error",
          value: "Sign-in failed at ponzu://auth?code=abc",
          stacktrace: { frames: [{ filename: "ponzu-studio://app/assets/index.js", lineno: 1 }] },
        },
      ],
    },
  };
  expect(scrubSecrets(event)).toEqual({
    event: "$exception",
    properties: {
      token: "phc_project_key",
      design_id: "dsn_1",
      count: 3,
      $exception_list: [
        {
          type: "Error",
          value: "Sign-in failed at ponzu://auth",
          stacktrace: { frames: [{ filename: "ponzu-studio://app/assets/index.js", lineno: 1 }] },
        },
      ],
    },
  });
});
