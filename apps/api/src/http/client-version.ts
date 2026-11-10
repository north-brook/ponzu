import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context.ts";
import { ApiError } from "./errors.ts";

/**
 * The header every Ponzu client sends: `<platform>/<version>`, like `macos/2.0.0` or
 * `ios/1.4.2`. The platform is the client's own name for itself, in lowercase letters.
 */
export const CLIENT_HEADER = "x-ponzu-client";

type Version = [major: number, minor: number, patch: number];

/** The oldest version each platform may run. A platform that is not listed is not gated. */
export type MinimumVersions = Record<string, string>;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.+-]*)?$/;

function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Reads `macos=2.1.0,ios=1.3.0`. Throws on anything else, so a typo cannot switch a gate off. */
export function parseMinimumVersions(text: string): MinimumVersions {
  const minimums: MinimumVersions = {};
  for (const entry of text.split(",").filter((part) => part.trim() !== "")) {
    const [platform, version, ...rest] = entry.trim().split("=");
    if (!platform || !/^[a-z]+$/.test(platform) || !version || rest.length > 0) {
      throw new Error(`"${entry}" is not <platform>=<version>`);
    }
    if (!parseVersion(version)) throw new Error(`"${version}" is not a version`);
    minimums[platform] = version;
  }
  return minimums;
}

function isOlder(version: Version, minimum: Version): boolean {
  for (let part = 0; part < 3; part++) {
    if (version[part]! !== minimum[part]!) return version[part]! < minimum[part]!;
  }
  return false;
}

/**
 * Refuses a client older than its platform's minimum with 426 and `client_too_old`, which the
 * apps answer by offering the update. A pre-release counts as its release.
 *
 * A request without the header passes: the gate is for our own apps, which always send it, and
 * is not a security boundary.
 */
export function clientVersionGate(minimums: MinimumVersions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header(CLIENT_HEADER);
    if (header === undefined) return next();
    const [platform, versionText, ...rest] = header.split("/");
    const version = versionText === undefined ? null : parseVersion(versionText);
    if (!platform || !/^[a-z]+$/.test(platform) || !version || rest.length > 0) {
      throw new ApiError(400, "invalid_request", `The ${CLIENT_HEADER} header is malformed.`, {
        details: { issues: [{ path: `header.${CLIENT_HEADER}`, message: "<platform>/<version>" }] },
      });
    }
    // The platform is the caller's word, and `constructor` is a property of every object.
    const minimum = Object.hasOwn(minimums, platform) ? minimums[platform] : undefined;
    if (minimum !== undefined && isOlder(version, parseVersion(minimum)!)) {
      throw new ApiError(426, "client_too_old", "This version of Ponzu is too old. Update it.", {
        details: { platform, minimumVersion: minimum },
      });
    }
    return next();
  };
}
