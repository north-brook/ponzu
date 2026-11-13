import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type KeyValueStorage, SESSION_KEY } from "../session.ts";

/** Dev's API, on the ponzu-api project's dev environment. */
export const DEV_API_URL = "https://api-dev.ponzu.design";

/**
 * Where an opt-in live test runs: PONZU_API_URL, else dev's. Never production's by default:
 * after launch api.ponzu.design is production, and a live test makes, wakes and deletes real
 * canvases. Running one against production takes naming it.
 */
export function liveApiUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.PONZU_API_URL || DEV_API_URL).replace(/\/+$/, "");
}

/**
 * The session `bun run dev:signin` saved (apps/api/scripts), as a session's storage, for the
 * opt-in live tests. A refresh writes the rotated pair back to the file whole or not at all: a
 * refresh token works once, and losing the new one would sign every later run out. Run one
 * live test with a file at a time.
 */
export function sessionFile(path: string): KeyValueStorage {
  const read = () =>
    JSON.parse(readFileSync(path, "utf8")) as {
      api: string;
      user: unknown;
      access_token: string;
      refresh_token: string;
    };
  return {
    async get(key) {
      if (key !== SESSION_KEY) return null;
      const saved = read();
      return JSON.stringify({
        accessToken: saved.access_token,
        refreshToken: saved.refresh_token,
        user: saved.user,
      });
    },
    async set(key, value) {
      if (key !== SESSION_KEY) return;
      const tokens = JSON.parse(value) as {
        accessToken: string;
        refreshToken: string;
        user: unknown;
      };
      const next = {
        ...read(),
        user: tokens.user,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        saved_at: new Date().toISOString(),
      };
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    },
    async delete() {
      // A test never signs the developer out.
    },
  };
}
