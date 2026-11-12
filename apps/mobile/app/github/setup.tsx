import { useMutation } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { announceInstall, type InstallOutcome } from "../../lib/cloud/install";
import { useCloud } from "../../lib/cloud/query";
import { rememberWorkspace } from "../../lib/cloud/workspace";
import { Juice } from "../../lib/slice";
import { useTheme } from "../../lib/theme";

/**
 * `<scheme>://github/setup?result=…&workspace=…`: the API's setup page, after GitHub's install
 * page, when its link reaches the app outside the install's auth session (the person finished
 * in Safari, or the sheet had gone). Usually the auth session takes that link itself
 * (lib/cloud/install.ts) and this never shows. It hands the outcome to "Where do you build?"
 * when that is on screen, or else asks GitHub again itself, and goes back to where it came
 * from. A link is only a request to look: it installs nothing.
 */
export default function GithubSetup() {
  const { result, workspace } = useLocalSearchParams<{ result?: string; workspace?: string }>();
  const cloud = useCloud();
  const sync = useMutation(cloud.mutations.syncGithub());
  const { color } = useTheme();
  const once = useRef(false);
  const syncNow = sync.mutate;
  const userId = cloud.userId;

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (result) {
      const outcome: InstallOutcome = {
        result,
        ...(workspace ? { workspaceId: workspace } : {}),
        via: "link",
      };
      if (result === "installed" && workspace && userId) void rememberWorkspace(userId, workspace);
      // "Where do you build?" syncs when it hears it; otherwise GitHub is asked from here.
      if (!announceInstall(outcome) && userId) syncNow();
    }
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [result, workspace, userId, syncNow]);

  return (
    <View
      testID="github-setup"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.bg }}
    >
      <Juice size={24} color={color.faint} />
    </View>
  );
}
