import { type Vault, VaultError } from "../vault/vault.ts";

/*
 * The daily email's unsubscribe link (`/v1/email/unsubscribe?t=<token>`). The token is the
 * person's id, then their id sealed by the vault under the binding `email-unsubscribe/<user id>`:
 *
 *   <user id>.pzv1.<key id>.<nonce>.<ciphertext and tag>
 *
 * Only the API's key can make one, a token made for one person does not open as another's, and
 * all one can do is turn that person's daily email off. It does not run out: an old email's link
 * still works.
 */

const COLUMN = "email-unsubscribe";

/** Every character a token can hold: an id, a dot, and the vault's base64url parts and dots. */
const TOKEN = /^(usr_[A-Za-z0-9]{1,60})\.(pzv1\.[A-Za-z0-9_.-]{1,600})$/;

/** A token that turns `userId`'s daily email off. */
export async function unsubscribeToken(vault: Vault, userId: string): Promise<string> {
  return `${userId}.${await vault.seal(userId, { column: COLUMN, row: userId })}`;
}

/** The person a token was made for, or null when it is not one the API made. */
export async function unsubscribeUser(vault: Vault, token: unknown): Promise<string | null> {
  if (typeof token !== "string") return null;
  const parts = TOKEN.exec(token);
  if (!parts) return null;
  const userId = parts[1]!;
  try {
    const opened = await vault.open(parts[2]!, { column: COLUMN, row: userId });
    return opened === userId ? userId : null;
  } catch (error) {
    if (error instanceof VaultError) return null;
    throw error;
  }
}
