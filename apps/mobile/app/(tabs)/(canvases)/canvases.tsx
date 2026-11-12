import { router, Stack } from "expo-router";
import { useRef } from "react";
import { type HostInstance, Pressable, ScrollView, Text, View } from "react-native";
import { CanvasNameRow } from "../../../components/canvas-name-row";
import { Lockup } from "../../../components/chrome";
import { useCanvases } from "../../../lib/cloud/canvases";
import { select } from "../../../lib/haptics";
import { LOCKUP_INK, measureMargin, useMargin } from "../../../lib/margin";
import { useTheme } from "../../../lib/theme";

/** What the list says when the workspace has no canvases: where they come from. */
export const EMPTY_CANVASES = "No canvases yet. Canvases you make in Ponzu show up here.";

/**
 * Canvases, the first tab: the workspace in view's canvases, newest activity first, under the
 * lockup in the system's see-through header. Tapping the lockup opens settings (account, sign
 * out). While nothing has come yet the lockup's slice juices: the app's one loading signal.
 *
 * This is the skeleton: names and where each lives. The rows with previews, status and the
 * needs-you order, the settled tray and opening a canvas each arrive with their own slice.
 */
export default function Canvases() {
  const { color } = useTheme();
  const { canvases, loading } = useCanvases();
  const m = useMargin();
  const header = useRef<HostInstance>(null);
  const openSettings = () => {
    select();
    router.push("/settings");
  };
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          {/* Where the header puts it is the margin (lib/margin.ts); the slice's ink sits on it. */}
          <View
            ref={header}
            onLayout={() => header.current?.measureInWindow((x) => measureMargin(x))}
          >
            <Pressable
              testID="lockup"
              accessibilityRole="button"
              accessibilityLabel="Settings"
              accessibilityHint="Your account, and signing out"
              onPress={openSettings}
              style={{ marginLeft: -LOCKUP_INK }}
            >
              <Lockup color={color.ink} busy={loading} />
            </Pressable>
          </View>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      <ScrollView
        testID="canvases"
        style={{ flex: 1, backgroundColor: color.bg }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 24 }}
      >
        {canvases?.map((canvas) => (
          <CanvasNameRow key={canvas.id} canvas={canvas} margin={m} />
        ))}
        {canvases?.length === 0 && (
          <Text
            testID="canvases-empty"
            style={{
              marginTop: 40,
              marginHorizontal: 40,
              textAlign: "center",
              fontFamily: "Inter",
              fontSize: 15,
              lineHeight: 22,
              color: color.muted,
            }}
          >
            {EMPTY_CANVASES}
          </Text>
        )}
      </ScrollView>
    </>
  );
}
