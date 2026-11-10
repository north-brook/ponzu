/**
 * The part of `fetch` the API's clients use. Every call the API makes to another service goes
 * through the one passed to `createDeps`, so a test can serve all of them from memory and be
 * sure nothing reaches the network.
 */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
