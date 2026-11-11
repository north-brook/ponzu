import { expect, test } from "bun:test";
import { IMAGE_RECORD, imageName, runnerClient, VERSION } from "./version.ts";

const record = (body: unknown) => (path: string) => {
  expect(path).toBe(IMAGE_RECORD);
  return typeof body === "string" ? body : JSON.stringify(body);
};

test("in an image, the runner names the snapshot it was baked into", () => {
  const inputs = "2de5aff8d90350a37fec16d85a27d92312032cdc06cbfdf39781f187948221b1";
  expect(imageName(record({ inputs, bun: {} }))).toBe("ponzu-runner-2de5aff8d903");
});

test("outside an image, or with a record it cannot read, it names none", () => {
  expect(
    imageName(() => {
      throw new Error("ENOENT");
    }),
  ).toBeNull();
  expect(imageName(record("not json"))).toBeNull();
  expect(imageName(record({ inputs: 42 }))).toBeNull();
  expect(imageName(record({ inputs: "../../etc" }))).toBeNull();
});

test("it says its version and its image as build metadata, or its version alone", () => {
  expect(runnerClient("ponzu-runner-2de5aff8d903")).toBe(
    `runner/${VERSION}+ponzu-runner-2de5aff8d903`,
  );
  expect(runnerClient(null)).toBe(`runner/${VERSION}`);
});
