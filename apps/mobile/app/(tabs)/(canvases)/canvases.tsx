import { router, Stack } from "expo-router";
import { useRef } from "react";
import { type HostInstance, Pressable, View } from "react-native";
import { CanvasList } from "../../../components/canvas-list";
import { Lockup } from "../../../components/chrome";
import { useCanvasList } from "../../../lib/cloud/canvases";
import { select } from "../../../lib/haptics";
import { LOCKUP_INK, measureMargin, useMargin } from "../../../lib/margin";
import { useTheme } from "../../../lib/theme";

/**
 * Canvases, the first tab: the Mac sidebar at phone size (docs/mobile.md, "The canvases list").
 * The workspace in view's canvases under the lockup in the system's see-through header
 * (components/canvas-list.tsx). Tapping the lockup opens settings (workspaces, account, usage).
 * While nothing has come yet the rows' shapes stand in and the lockup's slice juices.
 */
export default function Canvases() {
  const { color } = useTheme();
  const canvases = useCanvasList();
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
              accessibilityLabel={
                canvases.workspace ? `Settings, ${canvases.workspace.name}` : "Settings"
              }
              accessibilityHint="Your workspaces, your account and usage"
              onPress={openSettings}
              style={{ marginLeft: -LOCKUP_INK }}
            >
              <Lockup color={color.ink} busy={canvases.loading} />
            </Pressable>
          </View>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      <CanvasList {...canvases} margin={m} />
    </>
  );
}
