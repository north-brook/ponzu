import type { MenuAction } from "@react-native-menu/menu";
import { useHinge } from "expo-hinge";
import { Stack } from "expo-router";
// The toolbar's native item, for a badge expo-router's Button leaves out at the bottom. By its
// iOS file: the package's `./build/*` export maps to the bare file, the other platforms' stub.
import { RouterToolbarItem } from "expo-router/build/toolbar/native.ios";
import { type ReactElement, type ReactNode, useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
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
 * horizontal bars upright). On the rail each has an icon and a title, which
 * Apple needs for an item to go vertical; a custom view never does. Upright
 * the bar stays horizontal, so the file and the page are our pills in it,
 * laid out by the system beside Back and clear of the status bar.
 *
 * - `rail` closed (the outer display): Back and comments at the top, with
 *   the open threads' count, and the page under them.
 * - `rail` open sideways: Back and comments; the page is a pill on the canvas.
 * - `upright`: Back and the file top left, the page top right (its icon,
 *   name and chevron, as sideways), comments bottom right.
 */
export function NativeBarItems({
  bars,
  file,
  page,
  pages,
  onPage,
  pagePill,
  count,
  onComments,
  onBack,
  pageOnBar,
  comments,
}: {
  bars: "rail" | "upright";
  /** The file pill: a bar item of its own beside Back while the bars are upright. */
  file: ReactElement;
  page: { id: string; name: string; icon?: string } | undefined;
  pages: MenuAction[];
  onPage: (id: string) => void;
  /** The page pill with its menu: the page's bar item upright. */
  pagePill: ReactElement;
  count: number;
  onComments: () => void;
  onBack: () => void;
  /** The page is a bar item (closed, upright), not a pill on the canvas (open sideways). */
  pageOnBar: boolean;
  /** Where comments' button is (lib/duo-layout.ts `commentsButton`); null while they're shown. */
  comments: "rail" | "toolbar" | null;
}) {
  const { color } = useTheme();
  const upright = bars === "upright";
  const label = count ? `Comments, ${count} open` : "Comments";
  const openComments = () => {
    tick();
    onComments();
  };
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
        {/* The pill draws its own glass, as on the canvas: none of the bar's behind it. */}
        {upright && <Stack.Toolbar.View hidesSharedBackground>{file}</Stack.Toolbar.View>}
        {comments === "rail" && (
          <Stack.Toolbar.Button
            onPress={openComments}
            accessibilityLabel={label}
            // Its own round glass under Back's, never one capsule with it.
            separateBackground
          >
            <Stack.Toolbar.Icon renderingMode="template" xcasset="bar-comments" />
            <Stack.Toolbar.Label>Comments</Stack.Toolbar.Label>
            {count > 0 && (
              <Stack.Toolbar.Badge style={{ backgroundColor: brand.yuzu, color: brand.ink }}>
                {String(count)}
              </Stack.Toolbar.Badge>
            )}
          </Stack.Toolbar.Button>
        )}
      </Stack.Toolbar>
      {pageOnBar && pages.length > 1 && (
        <Stack.Toolbar placement="right">
          {upright ? (
            <Stack.Toolbar.View hidesSharedBackground>{pagePill}</Stack.Toolbar.View>
          ) : (
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
          )}
        </Stack.Toolbar>
      )}
      {comments === "toolbar" && (
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
            accessibilityLabel={label}
            onSelected={openComments}
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
 * The page pill, on the canvas open sideways (the Duo board's 5) and in the
 * bar upright: the page's icon, name and a chevron, in glass, opening the
 * pages' native menu. As the file pill, its glass dissolves while a board
 * is focused and what it holds fades on the chrome's clock (`fade`).
 */
export function PagePill({
  page,
  menu,
  shown,
  fade,
}: {
  page: { name: string; icon?: string } | undefined;
  /** Wraps the pill in the pages' menu. */
  menu: (pill: ReactNode) => ReactNode;
  shown: boolean;
  /** The chrome's fade, for what the glass holds (the glass itself is never faded). */
  fade: ReturnType<typeof useAnimatedStyle>;
}) {
  const { color } = useTheme();
  return menu(
    <View accessible accessibilityRole="button" accessibilityLabel={`Page: ${page?.name ?? ""}`}>
      <Glass interactive shown={shown} style={{ height: 44 }}>
        <Animated.View
          style={[
            {
              height: 44,
              paddingLeft: 13,
              paddingRight: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
            },
            fade,
          ]}
        >
          <PageIcon name={page?.icon} size={18} color={color.ink} />
          <Text
            numberOfLines={1}
            style={{
              maxWidth: 220,
              fontFamily: "Inter",
              fontWeight: "600",
              fontSize: 16,
              color: color.ink,
            }}
          >
            {page?.name ?? ""}
          </Text>
          <Chevron size={14} color={color.muted} />
        </Animated.View>
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
 * Comments as an inset panel over the canvas open sideways (the board's 6):
 * the sheet's look, 34pt corners, floating 10pt in from the canvas's right
 * edge (the rail beyond it), 344pt wide.
 */
export function CommentsPanel({ right, children }: { right: number; children: ReactNode }) {
  const { color } = useTheme();
  return (
    <Animated.View
      testID="comments-panel"
      style={{
        position: "absolute",
        top: 10,
        bottom: 10,
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
 * A full-bleed comments half (laptop and book): the card's color from the
 * fold itself to the window's edges, under the rail too, so the two halves
 * meet at the fold with nothing of ours between them. Inside, the board's
 * padding, with what it holds kept `CREASE` clear of the fold and clear of
 * the rail.
 */
export function CommentsHalf({
  split,
  style,
  right,
  children,
}: {
  split: "beside" | "below";
  style: { left: number; top: number; width: number; height: number };
  /** The rail's width, which the half runs under. */
  right: number;
  children: ReactNode;
}) {
  const { color } = useTheme();
  const below = split === "below";
  return (
    <View
      testID="comments-half"
      style={{
        position: "absolute",
        ...style,
        // Under a new comment's sheet (9), which the keyboard carries up over it like a laptop.
        zIndex: 8,
        backgroundColor: color.card,
        paddingTop: below ? CREASE + 30 : 24,
        paddingLeft: below ? 28 : CREASE + 22,
        paddingRight: (below ? 28 : 22) + right,
        paddingBottom: below ? 34 : 22,
      }}
    >
      {children}
    </View>
  );
}
