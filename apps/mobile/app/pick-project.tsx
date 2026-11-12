import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Glass } from "../components/glass";
import { Check, Folder, Repo, Search } from "../components/icons";
import { backend } from "../lib/cloud/backend";
import { config } from "../lib/cloud/config";
import {
  choiceKey,
  type PickerGroup,
  type ProjectChoice,
  pickerGroups,
  stillOffered,
} from "../lib/cloud/create";
import { runInstall } from "../lib/cloud/install";
import { pickedProject, pickProject, useNewCanvasStore } from "../lib/cloud/new-canvas";
import { useCloud } from "../lib/cloud/query";
import { useProjects } from "../lib/cloud/use-projects";
import { CREATE, PICKER } from "../lib/copy";
import { fail, select, tick } from "../lib/haptics";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";

/**
 * Pick a project, a sheet from New canvas's project control: a search, then a group for each of
 * the person's workspaces (their own first), each its Scratch and then the repos they can push
 * to there, pushed to lately first. The one chosen is ticked. Picking one in another workspace
 * moves the app to that workspace, as the Mac's picker does, and New canvas follows. At the
 * foot, "Allow more on GitHub" opens GitHub's install page in the system's auth session; the
 * repos are asked again however it ends.
 */
export default function PickProject() {
  const { color } = useTheme();
  const cloud = useCloud();
  useNewCanvasStore();
  const { workspace, choose, shelves } = useProjects();
  const [query, setQuery] = useState("");
  const [allowing, setAllowing] = useState(false);
  const installing = useRef(false);
  const sync = useMutation(cloud.mutations.syncGithub());
  const groups = shelves ? pickerGroups(shelves, query) : [];
  const here = workspace?.id ?? null;
  const herRepos = shelves?.find((s) => s.workspaceId === here)?.repos ?? null;
  const current = here ? stillOffered(pickedProject(here), herRepos) : null;
  const chosen = current && here ? choiceKey(current, here) : null;

  const pick = (choice: ProjectChoice, workspaceId: string) => {
    select();
    // Another workspace's project: the app moves to that workspace, and the list with it.
    if (workspaceId !== here) choose(workspaceId);
    pickProject(workspaceId, choice);
    if (router.canGoBack()) router.back();
  };

  const allowMore = async () => {
    if (installing.current) return;
    installing.current = true;
    tick();
    setAllowing(true);
    try {
      await runInstall({
        github: backend.api.github,
        scheme: config().scheme,
        openAuthSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
        dismissAuthSession: () => WebBrowser.dismissAuthSession(),
      });
    } catch {
      // The install page couldn't be had.
      fail();
    } finally {
      installing.current = false;
      setAllowing(false);
      // However it ended: GitHub says what Ponzu reaches now, and each workspace's repos follow
      // (the sync asks for every workspace again).
      sync.mutate();
    }
  };

  return (
    <ScrollView
      testID="pick-project"
      style={{ flex: 1, backgroundColor: color.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: 22, gap: 8 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text
        accessibilityRole="header"
        style={{
          fontFamily: "Funnel Display",
          fontWeight: "700",
          fontSize: 22,
          lineHeight: 26,
          color: color.ink,
          paddingHorizontal: 4,
          marginBottom: 6,
        }}
      >
        {PICKER.title}
      </Text>
      <Glass style={{ height: 44, borderRadius: 22, marginBottom: 6 }}>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 14,
          }}
        >
          <Search color={color.faint} size={16} />
          <TextInput
            testID="pick-project-search"
            accessibilityLabel={CREATE.search}
            placeholder={CREATE.search}
            placeholderTextColor={color.faint}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={{ flex: 1, fontFamily: "Inter", fontSize: 16, color: color.ink }}
          />
        </View>
      </Glass>
      {shelves === undefined ? <LoadingRow /> : null}
      {groups.map((group) => (
        <Group key={group.workspaceId} group={group} chosen={chosen} onPick={pick} />
      ))}
      <Pressable
        testID="pick-project-allow-more"
        accessibilityRole="link"
        accessibilityLabel={herRepos?.length === 0 ? CREATE.allowRepos : CREATE.allowMore}
        accessibilityState={{ busy: allowing }}
        disabled={allowing}
        onPress={() => void allowMore()}
        style={({ pressed }) => ({
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 12,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ fontFamily: "Inter", fontSize: 14, color: color.muted }}>
          {`${herRepos?.length === 0 ? CREATE.allowRepos : CREATE.allowMore} ↗`}
        </Text>
        {allowing ? <Juice size={12} color={color.faint} /> : null}
      </Pressable>
    </ScrollView>
  );
}

function Group({
  group,
  chosen,
  onPick,
}: {
  group: PickerGroup;
  chosen: string | null;
  onPick: (choice: ProjectChoice, workspaceId: string) => void;
}) {
  const { color } = useTheme();
  const scratch: ProjectChoice = { kind: "scratch" };
  return (
    <View testID={`pick-project-group-${group.workspaceId}`} style={{ gap: 2 }}>
      {group.heading ? (
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 13,
            color: color.muted,
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: 4,
          }}
        >
          {group.heading}
        </Text>
      ) : null}
      <View style={{ borderRadius: 14, backgroundColor: color.card, overflow: "hidden" }}>
        {group.scratch ? (
          <Row
            testID={`pick-project-scratch-${group.workspaceId}`}
            label={
              group.heading
                ? `${PICKER.scratch} in ${group.heading}, ${PICKER.scratchLine}`
                : `${PICKER.scratch}, ${PICKER.scratchLine}`
            }
            icon={<Folder color={color.muted} size={16} />}
            title={PICKER.scratch}
            line={PICKER.scratchLine}
            checked={choiceKey(scratch, group.workspaceId) === chosen}
            onPress={() => onPick(scratch, group.workspaceId)}
          />
        ) : null}
        {group.repos.map((repo) => (
          <Row
            key={repo.id}
            testID={`pick-project-repo-${repo.id}`}
            label={`${repo.owner}/${repo.name}`}
            icon={<Repo color={color.muted} size={16} />}
            title={
              <>
                <Text style={{ color: color.faint }}>{`${repo.owner}/`}</Text>
                {repo.name}
              </>
            }
            checked={repo.id === chosen}
            onPress={() => onPick({ kind: "repo", repo }, group.workspaceId)}
          />
        ))}
        {group.loading ? <LoadingRow /> : null}
      </View>
    </View>
  );
}

function Row({
  testID,
  label,
  icon,
  title,
  line,
  checked,
  onPress,
}: {
  testID: string;
  label: string;
  icon: ReactNode;
  title: ReactNode;
  line?: string;
  checked: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: checked }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: pressed ? color.chip : "transparent",
      })}
    >
      {icon}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 16, color: color.ink }}
        >
          {title}
        </Text>
        {line ? (
          <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.faint }}>{line}</Text>
        ) : null}
      </View>
      {checked ? <Check color={color.ink} /> : null}
    </Pressable>
  );
}

function LoadingRow() {
  const { color } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={CREATE.loadingRepos}
      style={{
        height: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
      }}
    >
      <View style={{ width: 16, height: 16, borderRadius: 4, backgroundColor: color.chip }} />
      <View style={{ width: "40%", height: 10, borderRadius: 3, backgroundColor: color.chip }} />
    </View>
  );
}
