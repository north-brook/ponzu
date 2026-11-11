// `@ponzu/client`: what the Mac app, the phone and a browser share to talk to Ponzu Cloud.
// No Node APIs and no DOM: it runs as it is in Electron's renderer, a browser and Hermes.
export {
  type AgentDefaultsBody,
  type AnswerBody,
  type Api,
  type ApiOptions,
  type CreateDesignBody,
  createApi,
  type OnboardingStep,
  type PullRequestFile,
  type PullRequestTab,
  type SendMessageBody,
  type ThreadPage,
  type UploadFile,
} from "./api.ts";
export {
  type BorrowedSessionOptions,
  borrowSession,
  type SessionLender,
} from "./borrowed-session.ts";
export { type Clock, systemClock } from "./clock.ts";
export { type CachedDesign, DocCache } from "./doc-cache.ts";
export { ApiError, type ClientErrorCode } from "./errors.ts";
export { IDEAS_RETRY_MS, type Idea, type IdeasState, watchRepoIdeas } from "./ideas.ts";
export {
  createLive,
  type Live,
  type LiveOptions,
  type LiveSnapshot,
  type LiveStatus,
} from "./live/live.ts";
export {
  neonRealtime,
  type RealtimeListener,
  type RealtimeStatus,
  type RealtimeSubscription,
  type RealtimeTransport,
  type Sealed,
} from "./live/realtime.ts";
export type {
  DesignHeadRow,
  DesignListRow,
  LiveArgs,
  LiveQueryName,
  LiveRows,
  MeRow,
  PresenceRow,
  QuestionRow,
} from "./live/rows.ts";
export { byRecentActivity, bySeq, PRESENCE_TTL_MS, presentNow } from "./live/sort.ts";
export {
  type Randomness,
  readRedirect,
  SignInError,
  type SignInStart,
  startSignIn,
} from "./pkce.ts";
export type { Fetch, Profile } from "./rpc.ts";
export {
  createSession,
  type KeyValueStorage,
  SESSION_KEY,
  type Session,
  type SessionHost,
  type SessionOptions,
  type SessionState,
  SessionStorageError,
} from "./session.ts";
