// What a client may import from this package (`@ponzu/api/types`), and all it may: the app's
// routes as a type, for `hc<AppType>(url)`. Types only, so importing it runs nothing here.
import type { MAX_QUERIES } from "./routes/live.ts";

export type { AppType } from "./create-app.ts";
export type { ErrorBody, ErrorCode } from "./http/errors.ts";

/** The most live queries one `POST /v1/live` takes: a client with more splits them. */
export type MaxLiveQueries = typeof MAX_QUERIES;
