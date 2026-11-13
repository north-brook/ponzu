import billingStarts from "./billing-starts.ts";
import type { NoticeFile } from "./define.ts";
import devCheck from "./dev-check.ts";
import suspension from "./suspension.ts";

export type { NoticeDay, NoticeFile, NoticeKind } from "./define.ts";

/** Every legal notice there is, by id. A new notice is a new file and one line here. */
export const NOTICES: ReadonlyMap<string, NoticeFile> = new Map(
  [billingStarts, devCheck, suspension].map((notice): [string, NoticeFile] => [notice.id, notice]),
);
