import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type KeyValueStorage, SESSION_KEY } from "@ponzu/client";

/*
 * A developer's saved session (`bun run dev:signin` in apps/api) as the session's storage, for
 * driving the app against the real API without a browser: `PONZU_SESSION_FILE=<path>`. Opt in
 * only, and said so in the log at launch. The access token lasts five minutes, so the session
 * refreshes it and the rotated pair is written back whole or not at all: a refresh token works
 * once, and losing the new one would sign every later run out. Nothing here signs the
 * developer out of the file.
 */

interface Saved {
  api?: string;
  user: unknown;
  access_token: string;
  refresh_token: string;
  saved_at?: string;
}

export function sessionFileStorage(path: string): KeyValueStorage {
  const read = () => JSON.parse(readFileSync(path, "utf8")) as Saved;
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
      const next: Saved = {
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
    async delete() {},
  };
}
