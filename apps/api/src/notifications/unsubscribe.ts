/*
 * The unsubscribe tokens moved to email/unsubscribe.ts, where every email that can be turned off
 * makes its own. This keeps the old names for the digest's callers.
 */
export {
  openUnsubscribeToken,
  unsubscribeToken,
  unsubscribeUser,
} from "../email/unsubscribe.ts";
