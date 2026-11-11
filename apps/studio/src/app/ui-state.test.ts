import { expect, test } from "bun:test";
import { NO_FILTER } from "../cloud/filter.ts";
import { DEFAULT_UI, filterFor, loadUi, saveUi } from "./ui-state.ts";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("each person's window comes back as they left it", () => {
  const store = memory();
  const ui = {
    workspaceId: "ws_1",
    designs: { ws_1: "dsn_1" },
    sidebarOpen: false,
    railOpen: true,
    filters: { ws_1: { person: "usr_sam", projects: ["repo:repo_1"] } },
  };
  saveUi("usr_maya", ui, store);
  expect(loadUi("usr_maya", store)).toEqual(ui);
  // Someone else on this computer starts from the defaults.
  expect(loadUi("usr_sam", store)).toEqual(DEFAULT_UI);
  expect(filterFor(ui, "ws_1")).toEqual({ person: "usr_sam", projects: ["repo:repo_1"] });
  expect(filterFor(ui, "ws_2")).toEqual(NO_FILTER);
});

test("what storage holds is checked, field by field: anything else counts as nothing", () => {
  const store = memory();
  store.values.set(
    "ponzu.ui.usr_maya",
    JSON.stringify({
      workspaceId: 7,
      designs: { ws_1: "dsn_1", ws_2: 3 },
      sidebarOpen: "yes",
      filters: { ws_1: { person: 1, projects: ["repo:a", 2] } },
    }),
  );
  expect(loadUi("usr_maya", store)).toEqual({
    ...DEFAULT_UI,
    designs: { ws_1: "dsn_1" },
    filters: { ws_1: { person: null, projects: ["repo:a"] } },
  });
  store.values.set("ponzu.ui.usr_maya", "{not json");
  expect(loadUi("usr_maya", store)).toEqual(DEFAULT_UI);
});

test("storage that can't be used only forgets, it never fails the window", () => {
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  expect(loadUi("usr_maya", broken)).toEqual(DEFAULT_UI);
  expect(() => saveUi("usr_maya", DEFAULT_UI, broken)).not.toThrow();
  expect(loadUi("usr_maya", null)).toEqual(DEFAULT_UI);
});
