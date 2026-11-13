import { router, Stack, useIsFocused } from "expo-router";
import { useEffect, useRef } from "react";
import { type HostInstance, Pressable, View } from "react-native";
import { CanvasList } from "../../../components/canvas-list";
import { Lockup } from "../../../components/chrome";
import { useCanvasList } from "../../../lib/cloud/canvases";
import { useFirstCanvas } from "../../../lib/cloud/use-first-canvas";
import { PICKER } from "../../../lib/copy";
import { select, tick } from "../../../lib/haptics";
import { setListNotice } from "../../../lib/list-notice";
import { LOCKUP_INK, measureMargin, useMargin } from "../../../lib/margin";
import { useTheme } from "../../../lib/theme";

/** What the list says when the workspace has no canvases (components/canvas-list-parts.tsx). */
export { EMPTY_CANVASES } from "../../../lib/copy";

/**
 * Canvases, the first tab: the Mac sidebar at phone size (docs/mobile.md, "The canvases list").
 * The workspace in view's canvases under the lockup in the system's see-through header
 * (components/canvas-list.tsx). Tapping the lockup opens settings (workspaces, account, usage);
 * New canvas, at the header's other end, pushes the create screen (app/new.tsx), which also
 * comes by itself, once, to someone whose workspace has no canvases yet.
 * While nothing has come yet the rows' shapes stand in and the lockup's slice juices.
 */
export default function Canvases() {
  const { color } = useTheme();
  const canvases = useCanvasList();
  const m = useMargin();
  const header = useRef<HostInstance>(null);
  useFirstCanvas(canvases);
  // A line said on arriving (lib/list-notice.ts) goes once the list is left.
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) setListNotice(null);
  }, [focused]);
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
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          accessibilityLabel={PICKER.newCanvas}
          onPress={() => {
            tick();
            router.push("/new");
          }}
        >
          <Stack.Toolbar.Icon renderingMode="template" xcasset="bar-new" />
          <Stack.Toolbar.Label>{PICKER.newCanvas}</Stack.Toolbar.Label>
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <CanvasList {...canvases} margin={m} />
    </>
  );
}
