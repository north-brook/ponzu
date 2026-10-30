import { expect, test } from "bun:test";
import type { Mac } from "./mac";
import { openTarget } from "./open-link";

const mac = (name: string): Mac => ({
  id: `${name}.tail1.ts.net`,
  name,
  dns: `${name}.tail1.ts.net`,
  kind: "desktop",
  addedAt: 1,
  via: "qr",
});
const workstation = mac("workstation");
const air = mac("air");
const FILE = "/Users/sam/git/seekle/.context/seekle-app.design";
const none = () => false;

test("an agent's link opens the design on the paired Mac it names", () => {
  expect(openTarget({ mac: "workstation", file: FILE }, [air, workstation], none)).toEqual({
    kind: "design",
    mac: "workstation.tail1.ts.net",
    key: FILE,
  });
  expect(
    openTarget({ mac: "air", file: FILE, artboard: "ab_hero" }, [air, workstation], none),
  ).toEqual({ kind: "design", mac: "air.tail1.ts.net", key: FILE, artboard: "ab_hero" });
  expect(
    openTarget({ mac: "air", file: FILE, page: "pg_flow", artboard: "ab_hero" }, [air], none),
  ).toEqual({ kind: "design", mac: air.id, key: FILE, page: "pg_flow", artboard: "ab_hero" });
});

test("a link to a Mac this phone hasn't paired says so", () => {
  expect(openTarget({ mac: "studio", file: FILE }, [workstation], none)).toEqual({
    kind: "unpaired",
    mac: "studio",
  });
});

test("a link without a Mac opens where a catalog lists it, or on the only Mac", () => {
  const onAir = (m: string, key: string) => m === air.id && key === FILE;
  expect(openTarget({ file: FILE }, [workstation, air], onAir)).toMatchObject({ mac: air.id });
  expect(openTarget({ file: FILE }, [workstation], none)).toMatchObject({ mac: workstation.id });
  expect(openTarget({ file: FILE }, [workstation, air], none)).toEqual({ kind: "missing" });
});

test("anything but a design link is refused, as the Mac app refuses it", () => {
  const all = [workstation];
  expect(openTarget({ repo: "north-brook/ponzu", path: "a.design" }, all, none).kind).toBe(
    "invalid",
  );
  expect(openTarget({ mac: "workstation", file: "/Users/sam/../etc.design" }, all, none).kind).toBe(
    "invalid",
  );
  expect(openTarget({ mac: "workstation", file: "relative.design" }, all, none).kind).toBe(
    "invalid",
  );
  expect(openTarget({ mac: "Work Station", file: FILE }, all, none).kind).toBe("invalid");
  expect(openTarget({ mac: "workstation", file: FILE, artboard: "a b" }, all, none).kind).toBe(
    "invalid",
  );
  expect(openTarget({ mac: "workstation", file: FILE, page: "../x" }, all, none).kind).toBe(
    "invalid",
  );
});
