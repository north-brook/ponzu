import { describe, expect, test } from "bun:test";
import { tilde } from "./file-info";

describe("tilde", () => {
  test("shows the home folder as ~", () => {
    expect(tilde("/Users/ada/work/app")).toBe("~/work/app");
    expect(tilde("/home/ada/work")).toBe("~/work");
  });

  test("drops the /private macOS resolves /tmp, /var and /etc into", () => {
    expect(tilde("/private/tmp/tl-v2")).toBe("/tmp/tl-v2");
    expect(tilde("/private/var/folders/x/y")).toBe("/var/folders/x/y");
    expect(tilde("/private/etc")).toBe("/etc");
  });

  test("keeps /private where it's the real folder", () => {
    expect(tilde("/private/tmpfoo")).toBe("/private/tmpfoo");
    expect(tilde("/private/stuff")).toBe("/private/stuff");
    expect(tilde("/srv/private/tmp")).toBe("/srv/private/tmp");
  });
});
