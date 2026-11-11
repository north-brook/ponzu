import { describe, expect, test } from "bun:test";
import type { Person } from "../model.ts";
import { type Member, roleEdit, sortMembers } from "./members.ts";

const person = (name: string): Person => ({
  id: name,
  name,
  login: name.toLowerCase(),
  avatarUrl: null,
});
const member = (name: string, role: Member["role"], owner = false): Member => ({
  person: person(name),
  role,
  owner,
});

describe("the role picker", () => {
  const bryce = member("Bryce", "admin", true);
  const sam = member("Sam", "admin");
  const maya = member("Maya", "member");

  test("is read-only to a member", () => {
    for (const m of [bryce, sam, maya])
      expect(roleEdit(m, [bryce, sam, maya], false)).toEqual({
        editable: false,
        reason: "not_admin",
      });
  });

  test("lets an admin promote a member and demote another admin", () => {
    expect(roleEdit(maya, [bryce, sam, maya], true)).toEqual({ editable: true });
    expect(roleEdit(sam, [bryce, sam, maya], true)).toEqual({ editable: true });
  });

  test("never demotes the account's owner on GitHub", () => {
    expect(roleEdit(bryce, [bryce, sam, maya], true)).toEqual({
      editable: false,
      reason: "owner",
    });
  });

  test("keeps the last admin an admin", () => {
    expect(roleEdit(sam, [sam, maya], true)).toEqual({ editable: false, reason: "last_admin" });
  });

  test("lists admins first, then by name", () => {
    const order = sortMembers([maya, member("Alex", "member"), sam, bryce]).map(
      (m) => m.person.name,
    );
    expect(order).toEqual(["Bryce", "Sam", "Alex", "Maya"]);
  });
});
