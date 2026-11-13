import { type Vault, VaultError } from "../vault/vault.ts";
import { UNSUBSCRIBE_CATEGORIES, type UnsubscribeCategory } from "./kinds.ts";

/*
 * An email's unsubscribe link (`/v1/email/unsubscribe?t=<token>`) and its `List-Unsubscribe`
 * header (docs/cloud.md, "Email"). The token names the person and what it stops, and seals both
 * with the vault under the binding `email-unsubscribe/<user id>`:
 *
 *   <user id>.<category>.pzv1.<key id>.<nonce>.<ciphertext and tag>
 *
 * The sealed text is `<user id>:<category>`, so a token made for one person does not open as
 * another's, and one made for the Friday recap cannot stop people-joined emails: the category is
 * inside the seal, not only beside it. Only the API's key can make one, and all one can do is
 * turn that one email off for that one person. Tokens do not run out.
 *
 * The daily email's first links (#550) are two parts, `<user id>.pzv1.…`, sealing the id alone.
 * They still open, as the digest's: no category is `pzv1`, so the two cannot be confused, and
 * every link already in an inbox keeps working.
 */

const COLUMN = "email-unsubscribe";

const USER = "usr_[A-Za-z0-9]{1,60}";
const SEALED = "pzv1\\.[A-Za-z0-9_.-]{1,600}";
/** Every character a token can hold: an id, a category, and the vault's base64url parts. */
const TOKEN = new RegExp(`^(${USER})\\.(${UNSUBSCRIBE_CATEGORIES.join("|")})\\.(${SEALED})$`);
/** #550's digest token: an id and its seal. */
const DIGEST_TOKEN = new RegExp(`^(${USER})\\.(${SEALED})$`);

/** A token that turns `userId`'s `category` emails off. */
export async function unsubscribeToken(
  vault: Vault,
  userId: string,
  category: UnsubscribeCategory = "digest",
): Promise<string> {
  const sealed = await vault.seal(`${userId}:${category}`, { column: COLUMN, row: userId });
  return `${userId}.${category}.${sealed}`;
}

/** Who a token was made for and what it stops, or null when it is not one the API made. */
export async function openUnsubscribeToken(
  vault: Vault,
  token: unknown,
): Promise<{ userId: string; category: UnsubscribeCategory } | null> {
  if (typeof token !== "string") return null;
  const parts = TOKEN.exec(token);
  if (parts) {
    const [, userId, category, sealed] = parts as unknown as [
      string,
      string,
      UnsubscribeCategory,
      string,
    ];
    return (await opens(vault, sealed, userId, `${userId}:${category}`))
      ? { userId, category }
      : null;
  }
  const old = DIGEST_TOKEN.exec(token);
  if (old) {
    const [, userId, sealed] = old as unknown as [string, string, string];
    return (await opens(vault, sealed, userId, userId)) ? { userId, category: "digest" } : null;
  }
  return null;
}

/** The person a token was made for, whatever it stops, or null. */
export async function unsubscribeUser(vault: Vault, token: unknown): Promise<string | null> {
  return (await openUnsubscribeToken(vault, token))?.userId ?? null;
}

async function opens(vault: Vault, sealed: string, userId: string, expected: string) {
  try {
    return (await vault.open(sealed, { column: COLUMN, row: userId })) === expected;
  } catch (error) {
    if (error instanceof VaultError) return false;
    throw error;
  }
}
