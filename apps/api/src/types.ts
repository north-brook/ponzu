// What a client may import from this package (`@ponzu/api/types`), and all it may: the app's
// routes as a type, for `hc<AppType>(url)`. Types only, so importing it runs nothing here.
export type { AppType } from "./create-app.ts";
export type { ErrorBody, ErrorCode } from "./http/errors.ts";
