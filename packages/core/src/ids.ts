const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short random id like `n_k3x9q`. Five base-36 characters is 60M values per prefix. */
export function newId(prefix: "n" | "ab" | "pg" | "th" | "m" = "n"): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  let out = `${prefix}_`;
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

/** Lowercase, dash-separated, safe for a file or folder name. */
export function slugify(name: string, fallback = "untitled"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

/** `base`, then `base-2`, `base-3`… until `taken` says no. */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
}
