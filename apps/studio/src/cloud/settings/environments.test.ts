import { describe, expect, test } from "bun:test";
import { canSaveSecret, secretName, secretNameError } from "./environments.ts";

const secrets = [
  { name: "DATABASE_URL", updatedAt: "2026-11-01T00:00:00Z" },
  { name: "STRIPE_SECRET_KEY", updatedAt: "2026-11-01T00:00:00Z" },
];

describe("a secret's name", () => {
  test("is written the way an environment variable is", () => {
    expect(secretName("stripe secret-key")).toBe("STRIPE_SECRET_KEY");
    expect(secretName("api.key$2")).toBe("APIKEY2");
    expect(secretName("")).toBe("");
  });

  test("can't start with a digit or repeat one already here", () => {
    expect(secretNameError("2FA_SEED", secrets)).toBe("Starts with a letter");
    expect(secretNameError("DATABASE_URL", secrets)).toBe("DATABASE_URL is already here");
    expect(secretNameError("SENTRY_DSN", secrets)).toBeNull();
  });

  test("keeps its own name while it is the one being edited", () => {
    expect(secretNameError("DATABASE_URL", secrets, "DATABASE_URL")).toBeNull();
  });

  test("a new one saves once it has a good name and a value", () => {
    expect(canSaveSecret("", "x", secrets)).toBe(false);
    expect(canSaveSecret("SENTRY_DSN", "", secrets)).toBe(false);
    expect(canSaveSecret("DATABASE_URL", "x", secrets)).toBe(false);
    expect(canSaveSecret("SENTRY_DSN", "https://…", secrets)).toBe(true);
  });
});
