import { type Effort, effortFor, effortsOf, type ModelOption } from "@ponzu/client/model";
import { type MenuAction, MenuView } from "@react-native-menu/menu";
import { Text, View } from "react-native";
import { CREATE, EFFORT_LABELS } from "../lib/copy";
import { select } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { AgentMark, Chevron } from "./icons";

export interface ModelSheetProps {
  /** What the person's Claude account offers, in its order. */
  models: readonly ModelOption[];
  /** The efforts to list for a model that does not say which it takes. */
  efforts: readonly Effort[];
  model: string;
  effort: Effort;
  onChange: (model: string, effort: Effort) => void;
}

/**
 * The model and effort a new canvas runs on, in the composer: Claude's mark, the model, the
 * effort in faint type, and a chevron (the Mac's model picker). A tap opens the system's menu
 * with the models, then the efforts the chosen one takes, or a line saying it takes none.
 * Choosing a model keeps the effort while it takes it (the shared `effortFor`).
 */
export function ModelSheet({ models, efforts, model, effort, onChange }: ModelSheetProps) {
  const { color } = useTheme();
  const label = models.find((m) => m.id === model)?.label ?? model;
  const takes = effortsOf(models, efforts, model);
  const actions: MenuAction[] = [
    {
      id: "models",
      title: CREATE.model,
      displayInline: true,
      subactions: models.map((m) => ({
        id: `model:${m.id}`,
        title: m.label,
        state: m.id === model ? "on" : "off",
      })),
    },
    {
      id: "efforts",
      title: CREATE.effort,
      displayInline: true,
      subactions: takes.length
        ? takes.map((e) => ({
            id: `effort:${e}`,
            title: EFFORT_LABELS[e],
            state: e === effort ? "on" : "off",
          }))
        : [{ id: "effort:none", title: CREATE.noEffort, attributes: { disabled: true } }],
    },
  ];
  return (
    <MenuView
      title={CREATE.model}
      actions={actions}
      onOpenMenu={select}
      onPressAction={({ nativeEvent }) => {
        const [kind, id] = splitAction(nativeEvent.event);
        if (kind === "model" && id && id !== model) {
          onChange(id, effortFor(models, efforts, id, effort));
        } else if (kind === "effort" && id && id !== "none" && id !== effort) {
          onChange(model, id as Effort);
        }
      }}
    >
      <View
        testID="new-canvas-model"
        accessible
        accessibilityRole="button"
        accessibilityLabel={
          takes.length
            ? `${CREATE.model}: ${label}, effort ${EFFORT_LABELS[effort]}`
            : `${CREATE.model}: ${label}`
        }
        style={{
          height: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          borderRadius: 999,
        }}
      >
        <AgentMark client="claude" size={14} color={color.ink} />
        <Text
          numberOfLines={1}
          style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 14, color: color.ink }}
        >
          {label}
          {takes.length ? (
            <Text style={{ fontWeight: "400", color: color.faint }}>
              {` ${EFFORT_LABELS[effort]}`}
            </Text>
          ) : null}
        </Text>
        <Chevron color={color.faint} size={12} />
      </View>
    </MenuView>
  );
}

/** `model:claude-opus-5-5` as its kind and id; a model id may itself hold a colon. */
function splitAction(event: string): [string, string | undefined] {
  const at = event.indexOf(":");
  return at < 0 ? [event, undefined] : [event.slice(0, at), event.slice(at + 1)];
}
