import { GlassContainer, GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../lib/theme";

/** Before iOS 26 the glass is a plain view; it gets the bar's surface instead. */
export const liquid = isLiquidGlassAvailable();

/**
 * Liquid Glass for what floats over the canvas and the screens: the bar
 * buttons, the title pill, the hint, the session card. On iOS 26 it's the
 * system's glass in the app's light or dark, refracting the design under
 * it; `interactive` glass answers a touch the way system buttons do. Before
 * iOS 26 it's the design's bar: the translucent bar color, a hairline and
 * the pop shadow (`--c-bar`, `--c-pop`).
 *
 * The glass itself is never clipped: Liquid Glass draws its rim and its
 * shadow just past its bounds. What it holds is clipped instead, to the same
 * corners.
 */
export function Glass({
  children,
  style,
  interactive = false,
  held = false,
  testID,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** A control: the glass responds to touch. */
  interactive?: boolean;
  /** Held open (the agent button while its card shows): the glass a step darker. */
  held?: boolean;
  testID?: string;
}) {
  const { color, scheme, shadow } = useTheme();
  return (
    <GlassView
      testID={testID}
      colorScheme={scheme}
      tintColor={held ? HELD[scheme] : undefined}
      isInteractive={interactive}
      style={[
        styles.shell,
        liquid
          ? null
          : {
              backgroundColor: held ? HELD[scheme] : color.bar,
              boxShadow: shadow.pop,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: color.hairline,
            },
        outer(style),
      ]}
    >
      <View style={[styles.clip, inner(style)]}>{children}</View>
    </GlassView>
  );
}

/**
 * Glass side by side: on iOS 26 shapes closer than `spacing` merge and
 * morph into each other like the system's, as the canvas bar's do.
 */
export function GlassGroup({
  children,
  spacing = 10,
  style,
}: {
  children: ReactNode;
  spacing?: number;
  style?: StyleProp<ViewStyle>;
}) {
  if (!liquid) return <View style={style}>{children}</View>;
  return (
    <GlassContainer spacing={spacing} style={style}>
      {children}
    </GlassContainer>
  );
}

const LAYOUT = [
  "alignItems",
  "flexDirection",
  "gap",
  "justifyContent",
  "padding",
  "paddingBottom",
  "paddingHorizontal",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingVertical",
] as const;

/**
 * The glass: the caller's style less the layout and padding its inner view
 * takes. Left on the glass, a row would shrink the inner view to its
 * content, and a spacer in it would have nothing to fill.
 */
function outer(style: StyleProp<ViewStyle>): ViewStyle {
  const rest: Record<string, unknown> = { ...StyleSheet.flatten(style) };
  for (const k of LAYOUT) delete rest[k];
  return rest as ViewStyle;
}

/** What the glass holds is laid out as the caller asked, and clipped to its corners. */
function inner(style: StyleProp<ViewStyle>): ViewStyle {
  const flat: ViewStyle = StyleSheet.flatten([styles.shell, style]) ?? {};
  const out: Record<string, unknown> = { borderRadius: flat.borderRadius };
  for (const k of LAYOUT) if (flat[k] !== undefined) out[k] = flat[k];
  if (flat.height !== undefined) out.height = "100%";
  return out as ViewStyle;
}

/** Held glass, a step darker: ink at 10% in light, white at 20% in dark. */
const HELD = { light: "rgba(17,17,16,0.10)", dark: "rgba(255,255,255,0.20)" } as const;

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  shell: { borderRadius: 999 },
});
