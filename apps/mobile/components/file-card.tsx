import { Pressable, Text, View } from "react-native";
import { shortAgent } from "../lib/agents";
import { type PhoneFile, shortAgo, whereLine } from "../lib/files";
import type { Run } from "../lib/search";
import { useScheme, useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { AgentMark, Branch, Folder, Repo } from "./icons";
import { MacImage } from "./preview";
import { Rain } from "./rain";
import { Shimmer } from "./shimmer";

/** The search's highlight: `#ffe89a` in light, yuzu at 32% in dark. */
export function useMarkColor() {
  return useScheme() === "dark" ? "rgba(255,200,30,0.32)" : "#ffe89a";
}

/** Text with the runs that matched a search marked. */
export function Marked({ runs, color }: { runs: Run[]; color: string }) {
  let at = 0;
  return runs.map((r) => {
    // A run's offset in the text is its stable key.
    const key = at;
    at += r.text.length;
    return r.hit ? (
      <Text key={key} style={{ backgroundColor: color, borderRadius: 2 }}>
        {r.text}
      </Text>
    ) : (
      r.text
    );
  });
}

/**
 * A design's card, as desktop's home screen draws it: the preview at 16:11,
 * the name with its time (or the agent's mark), and the project and branch
 * (or the folder) it's on. While an agent works in it, yuzu rain stands in for
 * the mark and the name shimmers; the yuzu dot marks changes since you looked.
 */
export function FileCard({
  file,
  width,
  unseen,
  name,
  project: showProject = true,
  onPress,
  onLongPress,
}: {
  file: PhoneFile;
  width: number;
  unseen: boolean;
  /** The name with search matches marked. */
  name?: Run[];
  /** Show the project: off when Designs is already filtered to one. */
  project?: boolean;
  onPress: () => void;
  /** Its actions: the shelf it's on. */
  onLongPress?: () => void;
}) {
  const { color, scheme } = useTheme();
  const markColor = useMarkColor();
  const working = file.agents?.find((a) => a.activity === "working") ?? null;
  const agent = working ?? file.agents?.[0] ?? null;
  const where = whereLine(file);
  const project = showProject ? where.project : null;
  const height = Math.round((width * 11) / 16);
  const dim = file.stale;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={file.name}
      testID={`card-${file.name}`}
      style={({ pressed }) => ({
        width,
        gap: 10,
        opacity: dim ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width,
          height,
          borderRadius: 12,
          backgroundColor: color.canvas,
          boxShadow: `0 0 0 1px ${color.hairline}`,
        }}
      >
        <View style={{ position: "absolute", inset: 0, borderRadius: 12, overflow: "hidden" }}>
          <MacImage
            mac={file.mac}
            url={file.preview ? `${file.preview}&theme=${scheme}` : null}
            live={!file.stale}
            style={{
              width: "100%",
              height: "100%",
              filter: dim ? [{ grayscale: 0.6 }] : undefined,
            }}
          />
        </View>
        {unseen && (
          <View
            accessibilityLabel="Changed since you looked"
            style={{
              position: "absolute",
              left: 8,
              top: 8,
              width: 10,
              height: 10,
              borderRadius: 999,
              backgroundColor: brand.yuzu,
              boxShadow: `0 0 0 1.5px ${color.card}, 0 0 0 2.5px rgba(17,17,16,0.18)`,
              zIndex: 4,
            }}
          />
        )}
      </View>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {working && !name ? (
            <Shimmer
              text={file.name}
              style={{
                flex: 1,
                fontFamily: "Inter",
                fontWeight: "500",
                fontSize: 15,
                lineHeight: 19.5,
              }}
              color={color.ink}
              surface={color.bg}
            />
          ) : (
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                fontFamily: "Inter",
                fontWeight: "500",
                fontSize: 15,
                lineHeight: 19.5,
                color: color.ink,
              }}
            >
              {name ? <Marked runs={name} color={markColor} /> : file.name}
            </Text>
          )}
          {working && !dim ? (
            <Rain columns={6} size={19} label={`${shortAgent(working.name)} is working`} />
          ) : agent ? (
            <AgentMark client={agent.client} size={14} color={color.ink} />
          ) : (
            <Text
              style={{
                fontFamily: "Inter",
                fontSize: 13,
                lineHeight: 13,
                color: color.faint,
                fontVariant: ["tabular-nums"],
              }}
            >
              {shortAgo(file.modified)}
            </Text>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {project && (
            <>
              <Repo size={13} color={color.faint} />
              <Text numberOfLines={1} style={[meta(color.muted), { flexShrink: 1, minWidth: 24 }]}>
                {project}
              </Text>
              <Text style={meta(color.faint)}>·</Text>
            </>
          )}
          {where.branch ? (
            <Branch size={13} color={color.faint} />
          ) : (
            <Folder size={13} color={color.faint} />
          )}
          <Text numberOfLines={1} style={[meta(color.muted), { flexShrink: 2, minWidth: 24 }]}>
            {where.branch ?? where.folder}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const meta = (c: string) => ({
  fontFamily: "Inter",
  fontSize: 13,
  lineHeight: 16.9,
  color: c,
});
