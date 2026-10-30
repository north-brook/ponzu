import type { MenuAction } from "@react-native-menu/menu";
import { useHinge } from "expo-hinge";
import { Stack } from "expo-router";
// The toolbar's native item, for a badge expo-router's Button leaves out at the bottom. By its
// iOS file: the package's `./build/*` export maps to the bare file, the other platforms' stub.
import { RouterToolbarItem } from "expo-router/build/toolbar/native.ios";
import { type ReactNode, useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { CREASE } from "../lib/duo-layout";
import { select, tick } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { brand, EASE_OUT } from "../lib/tokens";
import { barMenuItems } from "./bar-menu";
import { Glass } from "./glass";
import { Chevron, PageIcon } from "./icons";

const ease = Easing.bezier(...EASE_OUT);

/**
 * The canvas's bar items as the system's own (iPhone Duo's rail, and its
 * horizontal bars open upright): Back at the top, the page menu under it
 * where the page is on the rail, and comments at the foot, with the open
 * threads' count. Each has an icon and a title, which Apple needs for an
 * item to go vertical; a custom view never does.
 *
 * - `rail` closed (the outer display): Back and the page on the rail, comments at its foot.
 * - `rail` open sideways: Back on top, comments at the foot; the page is a pill on the canvas.
 * - `upright`: Back top left, the page top right, comments bottom right.
 */
export function NativeBarItems({
  page,
  pages,
  onPage,
  count,
  onComments,
  onBack,
  pageOnBar,
  commentsShown,
}: {
  page: { id: string; name: string; icon?: string } | undefined;
  pages: MenuAction[];
  onPage: (id: string) => void;
  count: number;
  onComments: () => void;
  onBack: () => void;
  /** The page menu is a bar item (closed, upright), not a pill on the canvas (open sideways). */
  pageOnBar: boolean;
  /** Comments are already there (folded): no button for them. */
  commentsShown: boolean;
}) {
  const { color } = useTheme();
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          onPress={() => {
            tick();
            onBack();
          }}
          accessibilityLabel="Back"
        >
          <Stack.Toolbar.Icon renderingMode="template" xcasset="bar-back" />
          <Stack.Toolbar.Label>Back</Stack.Toolbar.Label>
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {pageOnBar && pages.length > 1 && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu accessibilityLabel={`Page: ${page?.name ?? ""}`} title="Pages">
            <Stack.Toolbar.Icon
              renderingMode="template"
              xcasset={pages.find((p) => p.id === page?.id)?.image ?? "hi-board"}
            />
            <Stack.Toolbar.Label>{page?.name ?? "Page"}</Stack.Toolbar.Label>
            {barMenuItems(pages, (id) => {
              select();
              onPage(id);
            })}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      )}
      {!commentsShown && (
        <Stack.Toolbar placement="bottom">
          <Stack.Toolbar.Spacer />
          {/*
            The toolbar's own item, so it can wear the count: expo-router's Button drops a badge
            in the bottom toolbar, but UIKit draws one on any bar item (iOS 26), and the native
            item takes it (RouterToolbarItemView's badgeConfiguration).
          */}
          <RouterToolbarItem
            // A new item for a new count: UIKit takes the badge as the item is built.
            key={`comments-${count}`}
            identifier={`comments-${count}`}
            type="normal"
            title="Comments"
            xcassetName="bar-comments"
            imageRenderingMode="template"
            tintColor={color.ink}
            accessibilityLabel={count ? `Comments, ${count} open` : "Comments"}
            onSelected={() => {
              tick();
              onComments();
            }}
            {...(count > 0
              ? {
                  badgeConfiguration: {
                    value: String(count),
                    backgroundColor: brand.yuzu,
                    color: brand.ink,
                  },
                }
              : {})}
          />
        </Stack.Toolbar>
      )}
    </>
  );
}

/**
 * The page pill on the canvas open sideways (the Duo board's 5): the page's
 * icon, name and a chevron, in glass, opening the pages' native menu.
 */
export function PagePill({
  page,
  menu,
  shown,
}: {
  page: { name: string; icon?: string } | undefined;
  /** Wraps the pill in the pages' menu. */
  menu: (pill: ReactNode) => ReactNode;
  shown: boolean;
}) {
  const { color } = useTheme();
  return menu(
    <View accessible accessibilityRole="button" accessibilityLabel={`Page: ${page?.name ?? ""}`}>
      <Glass
        interactive
        shown={shown}
        style={{
          height: 44,
          paddingLeft: 13,
          paddingRight: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
        }}
      >
        <PageIcon name={page?.icon} size={18} color={color.ink} />
        <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 16, color: color.ink }}>
          {page?.name ?? ""}
        </Text>
        <Chevron size={14} color={color.muted} />
      </Glass>
    </View>,
  );
}

/**
 * A pill that glides between its places as iPhone Duo opens and closes (the
 * board's 4, Opening). The system animates its own bars between the rail
 * and horizontal; these are ours. Its place `x`, `y` changes with the
 * window and eases there over 420ms on the house ease-out. While the phone
 * is opening, `opening` (0 to 1, from the hinge's angle) carries it from
 * `from`, where it was closed, so it travels on the opening's own clock
 * rather than finishing while the inner display is still dark. Reduce
 * Motion puts it there at once.
 */
export function Glide({
  x,
  y,
  from,
  opening,
  children,
  testID,
}: {
  x: number;
  y: number;
  from?: { x: number; y: number };
  opening?: SharedValue<number>;
  children: ReactNode;
  testID?: string;
}) {
  const still = useReducedMotion();
  const px = useSharedValue(x);
  const py = useSharedValue(y);
  const fx = useSharedValue(from?.x ?? x);
  const fy = useSharedValue(from?.y ?? y);
  useEffect(() => {
    const o = { duration: still ? 0 : 420, easing: ease };
    px.value = withTiming(x, o);
    py.value = withTiming(y, o);
  }, [x, y]);
  useEffect(() => {
    if (from) {
      fx.value = from.x;
      fy.value = from.y;
    }
  }, [from?.x, from?.y]);
  const style = useAnimatedStyle(() => {
    const p = opening ? opening.value : 1;
    return {
      left: fx.value + (px.value - fx.value) * p,
      top: fy.value + (py.value - fy.value) * p,
    };
  });
  return (
    <Animated.View testID={testID} style={[{ position: "absolute", zIndex: 8 }, style]}>
      {children}
    </Animated.View>
  );
}

/**
 * How far the phone has opened, 0 to 1, for `Glide`: the hinge's angle from
 * where the inner display takes the window (about 30°) to flat. 1 whenever
 * the hinge isn't opening: flat, closed, without a hinge, or settled partly
 * open (the book pose has its own places). Follows the hinge's readings
 * on the UI thread, eased across the gaps between them.
 */
export function useOpening(active: boolean): SharedValue<number> {
  const hinge = useHinge();
  const still = useReducedMotion();
  const p = useSharedValue(1);
  const angle = hinge?.angle ?? 180;
  const target =
    active && hinge && hinge.status === "partiallyOpen"
      ? Math.min(1, Math.max(0, (angle - 30) / 150))
      : 1;
  useEffect(() => {
    p.value = still ? target : withTiming(target, { duration: 140, easing: Easing.linear });
  }, [target]);
  return p;
}

/**
 * Comments as an inset panel over the canvas open sideways (the board's 6),
 * and on an iPad wide enough: the sheet's look, 34pt corners, floating 10pt
 * in from the canvas's right edge (the rail beyond it, if there is one) and
 * from the bars above and below it, 344pt wide.
 */
export function CommentsPanel({
  right,
  top = 0,
  bottom = 0,
  children,
}: {
  right: number;
  /** What the system's bars take at the top and the foot (an iPad's), when they're horizontal. */
  top?: number;
  bottom?: number;
  children: ReactNode;
}) {
  const { color } = useTheme();
  return (
    <Animated.View
      testID="comments-panel"
      style={{
        position: "absolute",
        top: top + 10,
        bottom: bottom + 10,
        right: right + 10,
        width: 344,
        zIndex: 12,
        paddingTop: 18,
        paddingHorizontal: 20,
        paddingBottom: 20,
        borderRadius: 34,
        backgroundColor: color.card,
        boxShadow: `0 18px 50px rgba(0,0,0,${color.ink === "#111110" ? 0.14 : 0.55}), 0 0 0 0.5px ${color.hairline}`,
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * The fold, partly open: a 24pt band where nothing to tap sits, shaded as
 * the board draws it, so the crease reads as the hinge, not as content.
 */
export function Fold({
  axis,
  at,
}: {
  /** The fold runs across (laptop: a horizontal band) or down (book: a vertical one). */
  axis: "across" | "down";
  at: number;
}) {
  const { scheme } = useTheme();
  const dark = scheme === "dark";
  const band = axis === "across";
  return (
    <View
      pointerEvents="none"
      testID="fold"
      style={{
        position: "absolute",
        zIndex: 30,
        ...(band
          ? { left: 0, right: 0, top: at - CREASE, height: CREASE * 2 }
          : { top: 0, bottom: 0, left: at - CREASE, width: CREASE * 2 }),
      }}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="fold" x1="0" y1="0" x2={band ? "0" : "1"} y2={band ? "1" : "0"}>
            <Stop offset="0" stopColor="#000" stopOpacity={0} />
            <Stop offset="0.45" stopColor="#000" stopOpacity={dark ? 0.35 : 0.07} />
            <Stop offset="0.55" stopColor="#fff" stopOpacity={dark ? 0.05 : 0.5} />
            <Stop offset="1" stopColor="#fff" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#fold)" />
      </Svg>
    </View>
  );
}

/** A full-bleed comments half (laptop and book): the card's color, the board's padding. */
export function CommentsHalf({
  style,
  children,
}: {
  style: { left: number; top: number; width: number; height: number };
  children: ReactNode;
}) {
  const { color } = useTheme();
  return (
    <View
      testID="comments-half"
      style={{
        position: "absolute",
        ...style,
        zIndex: 11,
        backgroundColor: color.card,
        paddingTop: style.width > style.height ? 30 : 24,
        paddingHorizontal: style.width > style.height ? 28 : 22,
        paddingBottom: style.width > style.height ? 34 : 22,
      }}
    >
      {children}
    </View>
  );
}
