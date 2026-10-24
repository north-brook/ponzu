import { expect, test } from "bun:test";
import { innerStyle, outerStyle } from "./glass-split";

test("the inner view takes the layout and padding, the glass keeps its size and shape", () => {
  const flat = {
    height: 44,
    borderRadius: 22,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 14,
  };
  expect(outerStyle(flat)).toEqual({ height: 44, borderRadius: 22 });
  expect(innerStyle(flat)).toEqual({
    borderRadius: 22,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 14,
    height: "100%",
  });
});

test("a capsule sized by min-height keeps its inner view that tall", () => {
  // The comment field: in voice its children are all absolutely placed, so without the
  // min-height the clipped inner view is zero tall and the waveform is cut away.
  const flat = { minHeight: 44, borderRadius: 22, justifyContent: "flex-end" };
  expect(innerStyle(flat).minHeight).toBe(44);
  expect(innerStyle(flat).height).toBeUndefined();
  expect(outerStyle(flat).minHeight).toBe(44);
});

test("a capsule with neither height nor min-height sizes to its content", () => {
  const inner = innerStyle({ borderRadius: 999 });
  expect(inner.height).toBeUndefined();
  expect(inner.minHeight).toBeUndefined();
});
