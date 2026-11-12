import { pastedCode } from "@ponzu/client/model/claude";
import { ClipboardPasteButton, isPasteButtonAvailable } from "expo-clipboard";
import { Pressable, Text, TextInput, View } from "react-native";
import { CLAUDE } from "../lib/copy";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";
import { AgentMark, KeyIcon } from "./icons";
import { Card, MarkTile } from "./step";

/*
 * One way of connecting Claude being entered, as the Mac's card turns into it: the code
 * claude.ai shows after a sign-in (setup/code.tsx), or an Anthropic API key (setup/claude.tsx).
 * Its header names the way with Change beside it; under a hairline, the field and the line
 * under it, which a failure replaces in the danger color. The code's line ends with Open
 * sign-in again, the way on from every failure of a code.
 */

export function ClaudeTile() {
  return (
    <MarkTile>
      <AgentMark client="claude" size={17} color="#D97757" />
    </MarkTile>
  );
}

export function KeyTile() {
  const { color } = useTheme();
  return (
    <MarkTile>
      <KeyIcon color={color.muted} />
    </MarkTile>
  );
}

export function EntryCard({
  mode,
  value,
  connecting,
  error,
  onChange,
  onInput,
  onSubmit,
  onReopen,
  reopening = false,
}: {
  mode: "subscription" | "api_key";
  value: string;
  connecting: boolean;
  /** The failure to show in place of the helper, if any. */
  error: string | null;
  /** Back to the two ways. */
  onChange: () => void;
  onInput: (text: string) => void;
  onSubmit: () => void;
  /** The code only: start a new sign-in and open claude.ai again. */
  onReopen?: () => void;
  reopening?: boolean;
}) {
  const { color } = useTheme();
  const subscription = mode === "subscription";
  const label = subscription ? CLAUDE.codeLabel : CLAUDE.keyLabel;
  return (
    <Card>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        {subscription ? <ClaudeTile /> : <KeyTile />}
        <Text
          style={{
            flex: 1,
            fontFamily: "Inter",
            fontWeight: "500",
            fontSize: 16,
            color: color.ink,
          }}
        >
          {subscription ? CLAUDE.subscription : CLAUDE.apiKey}
        </Text>
        <Pressable
          testID="setup-claude-change"
          onPress={onChange}
          disabled={connecting}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={CLAUDE.change}
          accessibilityState={{ disabled: connecting }}
          style={({ pressed }) => ({ opacity: connecting ? 0.35 : pressed ? 0.6 : 1 })}
        >
          <Text
            style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 14, color: color.muted }}
          >
            {CLAUDE.change}
          </Text>
        </Pressable>
      </View>
      <View style={{ marginHorizontal: 16, height: 1, backgroundColor: color.hairline }} />
      <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, gap: 8 }}>
        <Text
          nativeID={`claude-${mode}-label`}
          style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 14, color: color.ink }}
        >
          {label}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextInput
            testID={`setup-claude-${subscription ? "code" : "key"}-field`}
            accessibilityLabel={label}
            accessibilityLabelledBy={`claude-${mode}-label`}
            // Focused as it opens: the person has just been sent here to paste.
            autoFocus
            value={value}
            editable={!connecting}
            onChangeText={(text) =>
              // A paste into the field arrives at once: lift the code from any words with it.
              onInput(subscription && text.length - value.length > 1 ? pastedCode(text) : text)
            }
            onSubmitEditing={onSubmit}
            returnKeyType="go"
            secureTextEntry={!subscription}
            placeholder={subscription ? undefined : CLAUDE.keyPlaceholder}
            placeholderTextColor={color.faint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textContentType="none"
            // Nothing typed here is offered back by the keyboard, or kept in its memory.
            autoComplete="off"
            importantForAutofill="no"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 10,
              paddingHorizontal: 12,
              backgroundColor: color.bg,
              borderWidth: 1,
              borderColor: error ? color.danger : color.hairline,
              fontFamily: subscription ? "IBM Plex Mono" : "Inter",
              fontSize: 15,
              color: color.ink,
            }}
          />
          {subscription && isPasteButtonAvailable ? (
            // iOS's own paste control: nothing is read from the clipboard without this tap,
            // and there is no "Allow Paste" alert.
            <ClipboardPasteButton
              testID="setup-claude-paste"
              acceptedContentTypes={["plain-text"]}
              displayMode="iconOnly"
              cornerStyle="capsule"
              foregroundColor={color.bg}
              backgroundColor={color.ink}
              style={{ width: 44, height: 44 }}
              onPress={(data) => {
                if (data.type === "text" && !connecting) onInput(pastedCode(data.text));
              }}
            />
          ) : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          <Text
            testID="setup-claude-help"
            accessibilityRole={error ? "alert" : "text"}
            accessibilityLiveRegion="polite"
            style={{
              fontFamily: "Inter",
              fontSize: 13,
              lineHeight: 18,
              color: error ? color.danger : color.faint,
            }}
          >
            {error ?? (subscription ? CLAUDE.codeHelp : CLAUDE.keyHelp)}
          </Text>
          {subscription && onReopen ? (
            <Pressable
              testID="setup-claude-reopen"
              onPress={onReopen}
              disabled={connecting || reopening}
              hitSlop={10}
              accessibilityRole="link"
              accessibilityLabel={CLAUDE.reopen}
              accessibilityState={{ disabled: connecting || reopening, busy: reopening }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                opacity: connecting ? 0.35 : pressed ? 0.6 : 1,
              })}
            >
              <Text
                style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.ink }}
              >
                {`${CLAUDE.reopen} ↗`}
              </Text>
              {reopening ? <Juice size={11} color={color.faint} /> : null}
            </Pressable>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
