import type { ComponentType } from "react";
import { HomeBoard, MarketBoard, NightBoard, ProductBoard, SunroomBoard } from "./boards";
import { BRAND_APP_BOARDS } from "./brand-app-boards";

export interface BoardMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  /** The highest `data-r` on the board: how many pieces the agent writes. */
  steps: number;
  Component: ComponentType<{ revised?: boolean }>;
}

/** Every artboard in the demo's Fernwood file. Where and when each appears lives in the engine. */
export const BOARDS: BoardMeta[] = [
  ...BRAND_APP_BOARDS.filter((b) => b.id === "logo" || b.id === "palette"),
  { id: "home", name: "Hero", width: 1440, height: 900, steps: 8, Component: HomeBoard },
  {
    id: "night",
    name: "Hero / Night Garden",
    width: 1440,
    height: 900,
    steps: 4,
    Component: NightBoard,
  },
  {
    id: "sunroom",
    name: "Hero / Sunroom",
    width: 1440,
    height: 900,
    steps: 5,
    Component: SunroomBoard,
  },
  {
    id: "market",
    name: "Hero / Market Day",
    width: 1440,
    height: 900,
    steps: 5,
    Component: MarketBoard,
  },
  {
    id: "product",
    name: "Product",
    width: 390,
    height: 844,
    steps: 6,
    Component: ProductBoard,
  },
  ...BRAND_APP_BOARDS.filter((b) => b.id.startsWith("app-")),
];
