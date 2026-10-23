import { describe, expect, test } from "bun:test";
import { driveFilm, type FilmDriver } from "./film.ts";

describe("driveFilm", () => {
  test("a film page that fails to open is still closed", async () => {
    let closed = 0;
    const driver: FilmDriver = {
      async open() {
        throw new Error("The studio isn't built.");
      },
      async evaluate<T>() {
        return undefined as T;
      },
      async capture() {
        return "";
      },
      async close() {
        closed++;
      },
    };
    await expect(
      driveFilm(driver, {
        url: "http://127.0.0.1:1/film",
        file: "x",
        shape: "16:9",
        theme: "light",
      }),
    ).rejects.toThrow("isn't built");
    expect(closed).toBe(1);
  });
});
