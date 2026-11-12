import { expect, test } from "bun:test";
import { redirectFor } from "./authorize";

test("the fake's authorize page sends Ponzu Dev's sign-in back with the fake code", () => {
  const url = new URL(
    "http://127.0.0.1:9/authorize?redirect_uri=ponzu-dev%3A%2F%2Fauth%2Fcallback&state=a%2Bb",
  );
  expect(redirectFor(url)).toBe("ponzu-dev://auth/callback?code=fake&state=a%2Bb");
});

test("it sends nothing anywhere else", () => {
  for (const url of [
    "http://127.0.0.1:9/authorize?redirect_uri=https%3A%2F%2Fevil.example&state=s",
    "http://127.0.0.1:9/authorize?redirect_uri=ponzu%3A%2F%2Fauth%2Fcallback&state=s",
    "http://127.0.0.1:9/authorize?redirect_uri=ponzu-dev%3A%2F%2Fauth%2Fcallback",
    "http://127.0.0.1:9/other?redirect_uri=ponzu-dev%3A%2F%2Fauth%2Fcallback&state=s",
  ]) {
    expect(redirectFor(new URL(url))).toBeNull();
  }
});
