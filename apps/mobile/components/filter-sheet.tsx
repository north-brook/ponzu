import {
  isFiltering,
  isProjectChecked,
  NO_FILTER,
  type Person,
  toggleProject,
} from "@ponzu/client/model";
import { Image } from "expo-image";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useCanvasFilter } from "../lib/cloud/canvases";
import { FILTER } from "../lib/copy";
import { select } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { font } from "../lib/tokens";
import { Check, Everyone, Folder, Repo } from "./icons";
import { SectionCard, SectionTitle } from "./settings-parts";

/**
 * The canvases list's filter, a sheet from the header's Filter (app/filter.tsx): the Mac
 * sidebar's filter menu at phone size (apps/studio/src/cloud/sidebar/filter-menu.tsx), on the
 * shared rules (@ponzu/client/model filter.ts). Person: Everyone, then you and the rest of a
 * team's members, one at a time; a personal workspace has nobody else, so no Person. Repo: each
 * repo with canvases and then Scratch, with how many, each checked or not; unchecking the last
 * one is no filter, as on the Mac. It changes the list as you choose and stays up until swiped
 * away; Clear filter, while one is on, puts everything back.
 */
export function FilterSheet() {
  const { color } = useTheme();
  const { me, choices, filter, setFilter } = useCanvasFilter();
  const { people, projects } = choices;
  const all = projects.map((project) => project.key);
  const choose = (next: typeof filter) => {
    select();
    setFilter(next);
  };
  return (
    <ScrollView
      testID="filter-sheet"
      style={{ flex: 1, backgroundColor: color.bg }}
      contentContainerStyle={{ padding: 20, gap: 12 }}
    >
      <Text
        accessibilityRole="header"
        style={{
          fontFamily: font.display,
          fontWeight: "700",
          fontSize: 26,
          lineHeight: 28,
          letterSpacing: -0.03 * 26,
          color: color.ink,
        }}
      >
        {FILTER.title}
      </Text>
      {people?.length ? (
        <>
          <SectionTitle>{FILTER.person}</SectionTitle>
          <SectionCard testID="filter-people">
            <Row
              testID="filter-person-everyone"
              role="radio"
              label={FILTER.everyone}
              checked={filter.person === null}
              first
              leading={
                <Round color={color.chip}>
                  <Everyone color={color.muted} />
                </Round>
              }
              onPress={() => choose({ ...filter, person: null })}
            />
            {people.map((person) => (
              <Row
                key={person.id}
                testID={`filter-person-${person.id}`}
                role="radio"
                label={person.id === me ? FILTER.you : person.name}
                checked={filter.person === person.id}
                leading={<Avatar person={person} />}
                onPress={() => choose({ ...filter, person: person.id })}
              />
            ))}
          </SectionCard>
        </>
      ) : null}
      {projects.length ? (
        <>
          <SectionTitle>{FILTER.repo}</SectionTitle>
          <SectionCard testID="filter-projects">
            {projects.map(({ key, repo, count }, i) => {
              const name = repo ? repo.name : FILTER.scratch;
              return (
                <Row
                  key={key}
                  testID={`filter-project-${key}`}
                  role="checkbox"
                  label={`${name}, ${count}`}
                  title={name}
                  count={count}
                  checked={isProjectChecked(filter, key)}
                  first={i === 0}
                  leading={
                    repo ? (
                      <Repo color={color.muted} size={16} />
                    ) : (
                      <Folder color={color.muted} size={16} />
                    )
                  }
                  onPress={() => choose(toggleProject(filter, key, all))}
                />
              );
            })}
          </SectionCard>
        </>
      ) : null}
      {isFiltering(filter) ? (
        <Pressable
          testID="filter-clear"
          accessibilityRole="button"
          accessibilityLabel={FILTER.clear}
          onPress={() => choose(NO_FILTER)}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text
            style={{ fontFamily: font.sans, fontWeight: "500", fontSize: 15, color: color.ink }}
          >
            {FILTER.clear}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function Row({
  testID,
  role,
  label,
  title,
  count,
  checked,
  first = false,
  leading,
  onPress,
}: {
  testID: string;
  role: "radio" | "checkbox";
  label: string;
  /** What the row says, when it isn't the label (a project's, without its count). */
  title?: string;
  count?: number;
  checked: boolean;
  first?: boolean;
  leading: ReactNode;
  onPress: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: 14,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: color.hairline,
        backgroundColor: pressed ? color.chip : undefined,
      })}
    >
      <View style={{ width: 22, alignItems: "center" }}>{leading}</View>
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontFamily: font.sans, fontSize: 15, color: color.ink }}
      >
        {title ?? label}
      </Text>
      {count !== undefined ? (
        <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.faint }}>{count}</Text>
      ) : null}
      <View style={{ width: 16 }}>{checked ? <Check color={color.ink} /> : null}</View>
    </Pressable>
  );
}

const ROUND = { width: 22, height: 22, borderRadius: 11 } as const;

function Round({ color, children }: { color: string; children?: ReactNode }) {
  return (
    <View
      style={[ROUND, { backgroundColor: color, alignItems: "center", justifyContent: "center" }]}
    >
      {children}
    </View>
  );
}

/** A person's picture, or the first letter of their name on the chip colour. */
function Avatar({ person }: { person: Person }) {
  const { color } = useTheme();
  if (person.avatarUrl) {
    return (
      <Image source={{ uri: person.avatarUrl }} accessibilityIgnoresInvertColors style={ROUND} />
    );
  }
  return (
    <Round color={color.chip}>
      <Text style={{ fontFamily: font.sans, fontWeight: "600", fontSize: 11, color: color.ink }}>
        {(person.name.trim()[0] ?? "?").toUpperCase()}
      </Text>
    </Round>
  );
}
