import { expect, test } from "bun:test";
import { cn } from "./cn.ts";

test("a size and a color from the tokens both stay", () => {
  expect(cn("text-13 text-muted")).toBe("text-13 text-muted");
  expect(cn("rounded-8 shadow-pop", "rounded-pill")).toBe("shadow-pop rounded-pill");
});

test("the later of two token colors wins", () => {
  expect(cn("text-muted", "text-faint")).toBe("text-faint");
  expect(cn("bg-hover", "bg-canvas")).toBe("bg-canvas");
  expect(cn("text-12", "text-13")).toBe("text-13");
});
