import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge has to know the token scales cloud.css defines, or it reads `text-13` as a
 * color and drops `text-muted` beside it.
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["9", "10", "11", "12", "13", "14", "15", "16", "18", "22", "26", "28", "34", "40"],
      radius: [
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "10",
        "11",
        "12",
        "14",
        "16",
        "18",
        "20",
        "pill",
      ],
      shadow: [
        "pop",
        "bar",
        "raised",
        "preview",
        "dot",
        "tip",
        "focus",
        "card",
        "button",
        "field",
        "field-focus",
        "field-error",
        "field-error-focus",
        "knob",
        "github",
        "board",
        "canvas-edge",
        "chosen",
        "note-field",
        "file-card",
        "halo",
        "pin",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
