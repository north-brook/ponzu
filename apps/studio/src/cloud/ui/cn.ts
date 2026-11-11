import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge has to know the token scales cloud.css defines, or it reads `text-13` as a
 * color and drops `text-muted` beside it.
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["9", "11", "12", "13", "14", "16", "34"],
      radius: ["2", "3", "4", "5", "6", "7", "8", "9", "10", "12", "14", "20", "pill"],
      shadow: ["pop", "bar", "raised", "preview", "dot", "tip", "focus"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
