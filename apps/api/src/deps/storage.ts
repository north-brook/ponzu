import { ApiError } from "../http/errors.ts";

/**
 * Where bytes live: a design's assets and previews, in Cloudflare R2.
 *
 * INTERFACE ONLY. The assets module owns the real implementation and may reshape this to fit
 * it; until then the deployed API has `storageNotBuilt`, and tests have `MemoryStorage`
 * (src/testing).
 */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

const notBuilt = async (): Promise<never> => {
  throw new ApiError(501, "not_implemented", "Ponzu cannot store files yet.");
};

export const storageNotBuilt: ObjectStorage = { put: notBuilt, get: notBuilt, delete: notBuilt };
