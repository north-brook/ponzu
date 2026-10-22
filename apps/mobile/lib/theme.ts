import { DarkTheme, DefaultTheme, type Theme } from "expo-router";
import { useColorScheme } from "react-native";
import { brand, dark, light, type Palette, shadow } from "./tokens";

export type Scheme = "light" | "dark";

/** The system's appearance; Ponzu has no setting of its own. */
export function useScheme(): Scheme {
  return useColorScheme() === "dark" ? "dark" : "light";
}

/** The palette, shadows and scheme for literal values in code. */
export function useTheme(): {
  scheme: Scheme;
  color: Palette;
  shadow: (typeof shadow)[Scheme];
} {
  const scheme = useScheme();
  return { scheme, color: scheme === "dark" ? dark : light, shadow: shadow[scheme] };
}

/** The navigation theme, colored from the palette; native headers and sheets read it. */
export function navigationTheme(scheme: Scheme): Theme {
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const color = scheme === "dark" ? dark : light;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: brand.yuzu,
      background: color.bg,
      card: color.bg,
      text: color.ink,
      border: color.hairline,
      notification: brand.yuzu,
    },
  };
}
