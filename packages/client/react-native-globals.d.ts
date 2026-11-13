/*
 * What React Native declares that the language's own library does not, and that the client's
 * request types name (session.ts, rpc.ts), which the model's typecheck reaches through the
 * client's error and route types (tsconfig.model.json). Copied from React Native's own
 * declaration (react-native/src/types/globals.d.ts), so the check allows what the phone has and
 * nothing a browser alone has. Outside src/, so the root typecheck, which has the DOM's own
 * `RequestInfo`, never sees it.
 */
type RequestInfo = Request | string;
