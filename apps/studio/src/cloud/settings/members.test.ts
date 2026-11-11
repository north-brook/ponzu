import { describe, expect, test } from "bun:test";
import type { Person } from "../model.ts";
import { type Member, type Role, roleEdit, sortMembers } from "./members.ts";

const person = (name: string): Person => ({
  id: name,
  name,
  login: name.toLowerCase(),
  avatarUrl: null,
});
const member = (name: string, role: Role, owner = false): Member => ({
  person: person(name),
  joined: true,
  role,
  owner,
});
/** Someone GitHub gives access who hasn't opened Ponzu yet. */
const notJoined = (name: string, owner = false): Member => ({
  person: person(name),
  joined: false,
  role: null,
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

  test("has nothing to change for someone who hasn't opened Ponzu, even for an admin", () => {
    const ting = notJoined("Ting", true);
    expect(roleEdit(ting, [bryce, sam, maya, ting], true)).toEqual({
      editable: false,
      reason: "not_joined",
    });
    expect(roleEdit(ting, [bryce, sam, maya, ting], false)).toEqual({
      editable: false,
      reason: "not_joined",
    });
  });

  test("doesn't count someone who hasn't opened Ponzu toward the admins", () => {
    // An owner on GitHub who hasn't opened Ponzu is no admin yet: Sam is still the last one.
    expect(roleEdit(sam, [sam, maya, notJoined("Ting", true)], true)).toEqual({
      editable: false,
      reason: "last_admin",
    });
  });

  test("lists those who have opened Ponzu first, then the rest by name", () => {
    const order = sortMembers([notJoined("Leo"), maya, notJoined("Ada"), sam]).map(
      (m) => m.person.name,
    );
    expect(order).toEqual(["Sam", "Maya", "Ada", "Leo"]);
  });
});
