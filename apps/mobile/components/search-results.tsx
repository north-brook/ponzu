import { type BoardHit, type CanvasHit, type CanvasSummary, segments } from "@ponzu/client/model";
import type { Match } from "@ponzu/core/search-text";
import { Image } from "expo-image";
import { type Href, router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { previewUri } from "../lib/cloud/list";
import { SEARCH } from "../lib/copy";
import { tick } from "../lib/haptics";
import {
  boardLine,
  canvasLine,
  type RecentRow,
  resultPath,
  type SearchResult,
  subtitle,
  type ThreadResult,
  threadAge,
  threadLine,
} from "../lib/search";
import { useTheme } from "../lib/theme";
import { brand, font } from "../lib/tokens";
import { useAfter, usePhoneSearch } from "../lib/use-search";
import { AgentAvatar, BoardIcon, PageIcon } from "./icons";

/*
 * What the Search tab shows under its field (lib/search.ts says what; this draws it): before
 * typing, the six canvases changed most recently; then Canvases, Boards and Threads, each
 * section only when it has something. A press opens the result, with a tick.
 */

/** The preview tile, board 3.2's: 64 × 48. */
const TILE = { width: 64, height: 48, radius: 8 } as const;

function open(result: SearchResult) {
  tick();
  router.push(resultPath(result) as Href);
}

export function SearchResults({
  query,
  margin,
  now = Date.now(),
}: {
  query: string;
  margin: number;
  /** The clock ages are read against. */
  now?: number;
}) {
  const { color } = useTheme();
  const { view, recent } = usePhoneSearch(query);
  const slow = useAfter(view.kind === "waiting", 300);
  const note = (testID: string, words: string) => (
    <Text
      testID={testID}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      style={{
        marginTop: 40,
        marginHorizontal: 40,
        textAlign: "center",
        fontFamily: font.sans,
        fontSize: 15,
        lineHeight: 22,
        color: color.muted,
      }}
    >
      {words}
    </Text>
  );
  switch (view.kind) {
    case "recent":
      return (
        <View testID="search-recent" style={{ paddingHorizontal: margin, gap: 10 }}>
          {recent.map((row) => (
            <RecentCanvas key={row.canvas.id} row={row} now={now} />
          ))}
        </View>
      );
    case "waiting":
      return slow ? note("search-searching", SEARCH.searching) : null;
    case "none":
      return note("search-none", SEARCH.noResults(view.query));
    case "failed":
      return note("search-failed", SEARCH.failed);
    case "results":
      return (
        <View testID="search-results" style={{ paddingHorizontal: margin }}>
          {view.canvases.length > 0 && (
            <Section label={SEARCH.canvases} id="canvases" first>
              {view.canvases.map((hit) => (
                <CanvasResult key={hit.canvas.id} hit={hit} now={now} />
              ))}
            </Section>
          )}
          {view.boards.length > 0 && (
            <Section label={SEARCH.boards} id="boards" first={!view.canvases.length}>
              {view.boards.map((hit) => (
                <BoardResult key={`${hit.canvas.id}/${hit.place}/${hit.id}`} hit={hit} />
              ))}
            </Section>
          )}
          {view.threads.length > 0 && (
            <Section
              label={SEARCH.threads}
              id="threads"
              first={!view.canvases.length && !view.boards.length}
            >
              {view.threads.map((result) => (
                <ThreadRow
                  key={`${result.kind}:${result.hit.canvas.id}/${result.hit.id}`}
                  result={result}
                  now={now}
                />
              ))}
            </Section>
          )}
        </View>
      );
  }
}

/** A section's label over its results, board 3.3's: 600 13, muted. */
function Section({
  label,
  id,
  first,
  children,
}: {
  label: string;
  id: string;
  first: boolean;
  children: ReactNode;
}) {
  const { color } = useTheme();
  return (
    <View testID={`search-section-${id}`}>
      <Text
        accessibilityRole="header"
        style={{
          paddingTop: first ? 0 : 22,
          paddingBottom: 10,
          paddingHorizontal: 4,
          fontFamily: font.sans,
          fontWeight: "600",
          fontSize: 13,
          lineHeight: 17,
          color: color.muted,
        }}
      >
        {label}
      </Text>
      <View style={{ gap: 10 }}>{children}</View>
    </View>
  );
}

/** `text` with each match on the pith ground search marks matches with. */
function Marked({ text, matches }: { text: string; matches: readonly Match[] }) {
  const { color } = useTheme();
  return (
    <>
      {segments(text, matches).map((s, i) =>
        s.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <Text key={i} style={{ backgroundColor: color.pinSoft }}>
            {s.text}
          </Text>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** A canvas's preview in the 64 × 48 tile, or the tile alone while it has none. */
function Tile({ canvas }: { canvas: CanvasSummary }) {
  const { color, scheme } = useTheme();
  const uri = previewUri(canvas.preview, scheme);
  return (
    <View
      style={{
        width: TILE.width,
        height: TILE.height,
        borderRadius: TILE.radius,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: color.hairline,
        backgroundColor: color.chip,
        overflow: "hidden",
      }}
    >
      {uri && (
        <Image
          source={{ uri }}
          cachePolicy="disk"
          contentFit="cover"
          contentPosition="top"
          recyclingKey={canvas.id}
          accessibilityIgnoresInvertColors
          style={{ width: "100%", height: "100%" }}
        />
      )}
    </View>
  );
}

/** A row: a leading tile, a first line and a muted second line. */
function Row({
  testID,
  label,
  onPress,
  lead,
  title,
  line,
  end,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  lead: ReactNode;
  title: ReactNode;
  line: string;
  end?: ReactNode;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderRadius: 10,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {lead}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              fontFamily: font.sans,
              fontWeight: "500",
              fontSize: 15,
              lineHeight: 19.5,
              color: color.ink,
            }}
          >
            {title}
          </Text>
          {end}
        </View>
        <Text
          numberOfLines={1}
          style={{ fontFamily: font.sans, fontSize: 13, lineHeight: 17, color: color.muted }}
        >
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

/** A before-typing row: the canvas, and what it's doing and when, board 3.2's grammar. */
function RecentCanvas({ row, now }: { row: RecentRow; now: number }) {
  const line = subtitle(row, now);
  const { canvas } = row;
  return (
    <Row
      testID={`search-recent-${canvas.id}`}
      label={`${canvas.name}, ${line}`}
      onPress={() => open({ kind: "canvas", hit: { canvas, matches: [] } })}
      lead={<Tile canvas={canvas} />}
      title={canvas.name}
      line={line}
    />
  );
}

/** The yuzu count of questions waiting on the viewer. */
function NeedsYouCount({ count }: { count: number }) {
  return (
    <View
      accessibilityLabel={SEARCH.questions(count)}
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 10,
        backgroundColor: brand.yuzu,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontFamily: font.sans, fontWeight: "600", fontSize: 12, color: brand.ink }}>
        {count}
      </Text>
    </View>
  );
}

function CanvasResult({ hit, now }: { hit: CanvasHit; now: number }) {
  const { canvas } = hit;
  const line = canvasLine(canvas, now);
  const asks = canvas.status === "active" ? canvas.needsYou : 0;
  return (
    <Row
      testID={`search-canvas-${canvas.id}`}
      label={[canvas.name, line, ...(asks ? [SEARCH.questions(asks)] : [])].join(", ")}
      onPress={() => open({ kind: "canvas", hit })}
      lead={<Tile canvas={canvas} />}
      title={<Marked text={canvas.name} matches={hit.matches} />}
      line={line}
      end={asks > 0 ? <NeedsYouCount count={asks} /> : undefined}
    />
  );
}

/** The tile a board or page result leads with: its mark on the chip ground. */
function Mark({ children }: { children: ReactNode }) {
  const { color } = useTheme();
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: color.chip,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}

function BoardResult({ hit }: { hit: BoardHit }) {
  const { color } = useTheme();
  const line = boardLine(hit);
  return (
    <Row
      testID={`search-${hit.place}-${hit.canvas.id}-${hit.id}`}
      label={`${hit.name}, ${line}`}
      onPress={() => open({ kind: "board", hit })}
      lead={
        <Mark>
          {hit.place === "page" ? (
            <PageIcon name={hit.icon ?? undefined} color={color.muted} />
          ) : (
            <BoardIcon color={color.muted} />
          )}
        </Mark>
      }
      title={<Marked text={hit.name} matches={hit.matches} />}
      line={line}
    />
  );
}

/** Who said it, 26pt: their picture or initial, Claude's mark, or an empty circle once gone. */
function Speaker({ result }: { result: ThreadResult }) {
  const { color } = useTheme();
  const { author } = result.hit;
  const round = { width: 26, height: 26, borderRadius: 13 } as const;
  if (author === "agent") {
    return (
      <AgentAvatar
        name={SEARCH.agent}
        client="claude"
        size={26}
        color={color.ink}
        soft={color.chip}
      />
    );
  }
  if (author === "deleted") return <View style={[round, { backgroundColor: color.chip }]} />;
  if (author.avatarUrl) {
    return (
      <Image source={{ uri: author.avatarUrl }} accessibilityIgnoresInvertColors style={round} />
    );
  }
  return (
    <View
      style={[
        round,
        { backgroundColor: color.chip, alignItems: "center", justifyContent: "center" },
      ]}
    >
      <Text style={{ fontFamily: font.sans, fontWeight: "600", fontSize: 11, color: color.ink }}>
        {(author.name.trim()[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}

/** A message or comment found: who and where, its age at the end, then its words. */
function ThreadRow({ result, now }: { result: ThreadResult; now: number }) {
  const { color } = useTheme();
  const line = threadLine(result);
  const age = threadAge(result, now);
  const { hit } = result;
  return (
    <Pressable
      testID={`search-${result.kind}-${hit.canvas.id}-${hit.id}`}
      accessibilityRole="button"
      accessibilityLabel={[line, ...(age ? [age] : []), hit.snippet].join(", ")}
      onPress={() => open(result)}
      style={({ pressed }) => ({ paddingVertical: 4, gap: 4, opacity: pressed ? 0.6 : 1 })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Speaker result={result} />
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            fontFamily: font.sans,
            fontSize: 13,
            lineHeight: 17,
            color: color.muted,
          }}
        >
          {line}
        </Text>
        {age && (
          <Text style={{ fontFamily: font.sans, fontSize: 13, lineHeight: 17, color: color.faint }}>
            {age}
          </Text>
        )}
      </View>
      <Text
        numberOfLines={3}
        style={{ fontFamily: font.sans, fontSize: 15, lineHeight: 21, color: color.ink }}
      >
        <Marked text={hit.snippet} matches={hit.matches} />
      </Text>
    </Pressable>
  );
}
