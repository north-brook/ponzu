import { useCallback, useState } from "react";
import { Alert, ScrollView, Text } from "react-native";
import { openCanvas } from "../lib/canvas/open";
import { backend } from "../lib/cloud/backend";
import type { CanvasList as List, ListRow } from "../lib/cloud/list";
import { fail, select, thud } from "../lib/haptics";
import { useListNotice } from "../lib/list-notice";
import { useTheme } from "../lib/theme";
import { EmptyTrace, FilteredEmpty, SettledHeader, SkeletonRows } from "./canvas-list-parts";
import { CanvasRow, type RowAction } from "./canvas-row";

/**
 * The canvases list under the tab's header: live rows in the Mac's order with their three
 * lines, the settled ones folded into a tray at the foot (closed until opened), the rows' shapes
 * while nothing has come, a faint trace for a workspace with nothing in it, and a plain line
 * with Clear filter when a filter keeps nothing. Offline it shows
 * the last rows kept on disk, as they were, not dimmed.
 */
export function CanvasList({
  list,
  loading,
  margin,
  filtering = false,
  onClearFilter,
}: {
  /** The rows to show: through the person's filter, on the Canvases tab. */
  list: List | undefined;
  loading: boolean;
  margin: number;
  /** A filter is on: an empty list says nothing matches it, with a way to clear it. */
  filtering?: boolean;
  onClearFilter?: () => void;
}) {
  const { color } = useTheme();
  const [trayOpen, setTrayOpen] = useState(false);
  // What sent the app here may say why (a ping for a canvas no longer the person's).
  const notice = useListNotice();
  // Settle or Reopen from a held row: the live row moves it, or it stays and says why.
  const act = useCallback((row: ListRow, action: RowAction) => {
    if (action === "settle") thud();
    else select();
    backend.api.canvases.settle(row.canvas.id, action === "settle").catch(() => {
      fail();
      Alert.alert(`“${row.canvas.name}” couldn't be changed. Try again.`);
    });
  }, []);
  const settled = list?.settled ?? [];
  return (
    <ScrollView
      testID="canvases"
      style={{ flex: 1, backgroundColor: color.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}
    >
      {notice && (
        <Text
          testID="canvases-notice"
          accessibilityRole="alert"
          style={{
            marginHorizontal: margin,
            marginTop: 4,
            marginBottom: 8,
            fontFamily: "Inter",
            fontSize: 15,
            lineHeight: 20,
            color: color.muted,
          }}
        >
          {notice}
        </Text>
      )}
      {loading && <SkeletonRows margin={margin} />}
      {list?.active.map((row) => (
        <CanvasRow
          key={row.canvas.id}
          row={row}
          margin={margin}
          onOpen={openCanvas}
          onAction={act}
        />
      ))}
      {list &&
        list.active.length === 0 &&
        settled.length === 0 &&
        (filtering ? (
          <FilteredEmpty margin={margin} onClear={onClearFilter} />
        ) : (
          <EmptyTrace margin={margin} />
        ))}
      {settled.length > 0 && (
        <SettledHeader
          count={settled.length}
          open={trayOpen}
          margin={margin}
          onToggle={setTrayOpen}
        />
      )}
      {trayOpen &&
        settled.map((row) => (
          <CanvasRow
            key={row.canvas.id}
            row={row}
            margin={margin}
            onOpen={openCanvas}
            onAction={act}
          />
        ))}
    </ScrollView>
  );
}
