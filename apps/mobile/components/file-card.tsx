import { Pressable, Text, View } from "react-native";
import { type PhoneFile, shortAgo, whereLine } from "../lib/files";
import type { Run } from "../lib/search";
import { useScheme, useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { AgentMark, Branch, Folder, MacIcon } from "./icons";
import { MacImage } from "./preview";
import { Shimmer } from "./shimmer";
import { Trace } from "./trace";

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
 * the name with its time (or the working agent's mark, the name shimmering),
 * and the branch (or folder) and Mac it's on. The yuzu trace runs round it
 * while an agent works in it; the yuzu dot marks changes since you looked.
 */
export function FileCard({
  file,
  width,
  unseen,
  name,
  onPress,
  onLongPress,
}: {
  file: PhoneFile;
  width: number;
  unseen: boolean;
  /** The name with search matches marked. */
  name?: Run[];
  onPress: () => void;
  /** Its actions: the shelf it's on. */
  onLongPress?: () => void;
}) {
  const { color, scheme } = useTheme();
  const markColor = useMarkColor();
  const working = file.agents?.find((a) => a.activity === "working") ?? null;
  const agent = working ?? file.agents?.[0] ?? null;
  const { branch, folder } = whereLine(file);
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
        {working && !dim && <Trace radius={12} />}
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
          {agent ? (
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
          {branch ? (
            <Branch size={13} color={color.faint} />
          ) : (
            <Folder size={13} color={color.faint} />
          )}
          <Text numberOfLines={1} style={[meta(color.muted), { flexShrink: 1, minWidth: 24 }]}>
            {branch ?? folder}
          </Text>
          <Text style={meta(color.faint)}>·</Text>
          <MacIcon kind={file.macKind} size={13} color={color.faint} />
          <Text numberOfLines={1} style={[meta(color.muted), { flexShrink: 2 }]}>
            {file.macName}
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
