import { expect, test } from "bun:test";
import { type Binding, createVault, generateVaultKey, sealedKeyId, VaultError } from "./vault.ts";

const key = generateVaultKey();
const vault = createVault({ key });
const maya: Binding = { column: "github_user_tokens.access_token", row: "usr_maya" };

test("what is sealed opens again, whatever it contains", async () => {
  for (const secret of [
    "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
    "",
    "päss wörd 🔑\nline two",
    "x".repeat(200_000),
  ]) {
    const sealed = await vault.seal(secret, maya);
    expect(await vault.open(sealed, maya)).toBe(secret);
  }
});

test("a sealed value is versioned text that names its key and shows nothing of the secret", async () => {
  const sealed = await vault.seal("ghu_secretsecretsecret", maya);
  expect(sealed).toMatch(/^pzv1\.[0-9a-f]{8}\.[\w-]{16}\.[\w-]+$/);
  expect(sealed).not.toContain("ghu_");
  expect(Buffer.from(sealed.split(".")[3]!, "base64url").toString("latin1")).not.toContain(
    "ghu_secret",
  );
});

test("sealing the same thing twice gives two different values", async () => {
  expect(await vault.seal("same", maya)).not.toBe(await vault.seal("same", maya));
});

test("a value that was altered anywhere does not open", async () => {
  const sealed = await vault.seal("ghu_secret", maya);
  const [format, keyId, nonce, ciphertext] = sealed.split(".") as [string, string, string, string];
  const flip = (text: string, at: number) => {
    const bytes = Buffer.from(text, "base64url");
    bytes[at]! ^= 1;
    return bytes.toString("base64url");
  };
  const altered = [
    [format, keyId, nonce, flip(ciphertext, 0)],
    [format, keyId, nonce, flip(ciphertext, Buffer.from(ciphertext, "base64url").length - 1)],
    [format, keyId, flip(nonce, 3), ciphertext],
    [format, keyId, nonce, ciphertext.slice(0, -4)],
    [format, keyId, nonce, `${ciphertext}!!`],
    ["pzv2", keyId, nonce, ciphertext],
    [format, keyId, nonce],
    [format, keyId, nonce, ciphertext, "extra"],
    ["not a vault value"],
  ];
  for (const parts of altered) {
    await expect(vault.open(parts.join("."), maya)).rejects.toBeInstanceOf(VaultError);
  }
});

test("a value moved to another person's row, or another column of its own row, does not open", async () => {
  const sealed = await vault.seal("ghu_mayas_token", maya);

  await expect(vault.open(sealed, { ...maya, row: "usr_ines" })).rejects.toBeInstanceOf(VaultError);
  await expect(
    vault.open(sealed, { column: "github_user_tokens.refresh_token", row: "usr_maya" }),
  ).rejects.toBeInstanceOf(VaultError);
  // A column and row that run together the same way are still a different place.
  await expect(
    vault.open(sealed, { column: "github_user_tokens.access_token\nusr", row: "_maya" }),
  ).rejects.toBeInstanceOf(VaultError);
});

test("an error never quotes the value or the secret", async () => {
  const sealed = await vault.seal("ghu_mayas_token", maya);
  const error = await vault.open(sealed, { ...maya, row: "usr_ines" }).catch((thrown) => thrown);
  expect(error.message).not.toContain(sealed.split(".")[3]!);
  expect(error.message).not.toContain("ghu_");
});

test("after a rotation the new key seals, and the old key still opens what it sealed", async () => {
  const sealedBefore = await vault.seal("old secret", maya);
  const next = generateVaultKey();
  const rotated = createVault({ key: next, oldKeys: [key] });

  expect(await rotated.open(sealedBefore, maya)).toBe("old secret");
  const sealedAfter = await rotated.seal("new secret", maya);
  expect(sealedAfter.split(".")[1]).not.toBe(sealedBefore.split(".")[1]);
  // Once the old key is retired, only what was sealed again survives.
  const retired = createVault({ key: next });
  expect(await retired.open(sealedAfter, maya)).toBe("new secret");
  await expect(retired.open(sealedBefore, maya)).rejects.toThrow(/not held/);
});

test("a key that is not 32 bytes of base64url is refused when the vault is made", () => {
  for (const bad of [
    "",
    "short",
    Buffer.alloc(31).toString("base64url"),
    Buffer.alloc(33).toString("base64url"),
    `${"A".repeat(42)}=`,
    "not base64url!".repeat(4),
  ]) {
    expect(() => createVault({ key: bad })).toThrow(VaultError);
  }
  expect(() => createVault({ key, oldKeys: ["short"] })).toThrow(VaultError);
});

test("a sealed value's key id reads without opening it, and matches the key that sealed it", async () => {
  const next = generateVaultKey();
  const rotated = createVault({ key: next, oldKeys: [key] });
  const { current, old } = await rotated.keyIds();
  expect(old).toEqual([(await vault.keyIds()).current]);
  expect(current).toMatch(/^[0-9a-f]{8}$/);
  expect(sealedKeyId(await rotated.seal("x", maya))).toBe(current);
  expect(sealedKeyId(await vault.seal("x", maya))).toBe(old[0]!);
  for (const bad of [
    "",
    "pzv1",
    "pzv1.abc.n.c",
    "pzv2.0011aabb.n.c",
    "pzv1.0011aabb.n",
    "pzv1.0011aabb.n.c.d",
  ]) {
    expect(sealedKeyId(bad)).toBeNull();
  }
});
