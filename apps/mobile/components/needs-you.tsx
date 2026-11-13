import {
  type Ask,
  type AskAnswer,
  answerable,
  answerOf,
  CHOICES,
  choose,
  type Draft,
  EMPTY_DRAFT,
  type Page,
  pagesOf,
} from "@ponzu/client/model";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { NEEDS_YOU } from "../lib/copy";
import { select, tick } from "../lib/haptics";
import { Markdown } from "../lib/markdown";
import { safeHref } from "../lib/prose";
import { useTheme } from "../lib/theme";
import { brand, font } from "../lib/tokens";
import { Glass } from "./glass";
import { Back, Check, Send } from "./icons";

const keyOf = (page: Page) => `${page.ask.id}:${page.index}`;
const isOpen = (ask: Ask) => ask.status === "open";

/** A plan's first paragraph: what shows before "Read the plan". */
export function firstParagraph(plan: string): { first: string; more: boolean } {
  const parts = plan
    .trim()
    .split(/\n[ \t]*\n/)
    .filter((p) => p.trim());
  return { first: parts[0] ?? "", more: parts.length > 1 };
}

/** Only a web address opens from a hand-off: the agent chose it, so it may be anything. */
export function webHref(url: string): string | null {
  const href = safeHref(url);
  return href && /^https?:\/\//i.test(href) ? href : null;
}

function hostOf(href: string): string {
  return /^https?:\/\/([^/?#:]+)/i.exec(href)?.[1] ?? href;
}

/**
 * Needs you (iPhone design §10, board 3.9): what the agent waits on, in the chat's composer
 * slot. One page at a time under its own header, with a pager `‹ n/m ›` across everything
 * waiting: each question of a multiple-choice ask is a page, and a plan, a permission, a secret
 * or a hand-off is one. A question's options sit on one quiet track, the chosen raised with a
 * tick; a note goes with any answer, or is the answer. Send answers the page in view and moves
 * on, and sends an ask once its last page is answered (the shared `answer.ts` rules, the Mac's).
 *
 * On a canvas the person may only look at, or offline, the card still shows what is asked, its
 * options unpressable, and the field's place says why.
 */
export function NeedsYou({
  asks,
  start,
  repoName,
  blocked,
  onAnswer,
  onTouch,
  onOpenLink,
}: {
  asks: Ask[];
  /** The ask to open at (a push's `question`), when it is among them. */
  start: string | null;
  /** Where a secret is kept: the repo's name, or null for Scratch. */
  repoName: string | null;
  /** Why the person can't answer now (read access, offline), in the field's place. */
  blocked: string | null;
  onAnswer: (askId: string, answer: AskAnswer) => void;
  /** The person started answering this ask: chose something or typed a note. */
  onTouch: (askId: string) => void;
  /** A link in a plan. */
  onOpenLink: (url: string) => void;
}) {
  const { color } = useTheme();
  const pages = pagesOf(asks);
  const [current, setCurrent] = useState<string | null>(start ? `${start}:0` : null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const at = Math.max(
    0,
    pages.findIndex((p) => keyOf(p) === current),
  );
  const page = pages[at];
  if (!page) return null;

  const draft = drafts[keyOf(page)] ?? EMPTY_DRAFT;
  const setDraft = (next: Draft) => {
    setDrafts((d) => ({ ...d, [keyOf(page)]: next }));
    onTouch(page.ask.id);
  };
  const go = (to: number) => {
    const next = pages[to];
    if (!next) return;
    tick();
    setCurrent(keyOf(next));
  };

  const { ask } = page;
  const busy = ask.status === "sending";
  const disabled = !isOpen(ask) || blocked !== null;
  const ready = !disabled && answerable(page, draft);

  const send = () => {
    if (!ready) return;
    const own = pages.filter((p) => p.ask.id === ask.id);
    const answer = answerOf(
      ask,
      own.map((p) => drafts[keyOf(p)] ?? EMPTY_DRAFT),
    );
    if (!answer) {
      // A page of this ask still says nothing: that one next.
      const missing = own.find((p) => !answerable(p, drafts[keyOf(p)] ?? EMPTY_DRAFT));
      if (missing) go(pages.indexOf(missing));
      return;
    }
    onAnswer(ask.id, answer);
    const next = pages.findIndex((p, i) => i > at && p.ask.id !== ask.id && isOpen(p.ask));
    if (next >= 0) go(next);
  };
  const advance = () => {
    // The ask's own next page, before it is sent.
    const next = pages[at + 1];
    if (next && next.ask.id === ask.id && ready) go(at + 1);
    else send();
  };

  const header =
    ask.kind === "question"
      ? ask.questions[page.index]!.header
      : {
          plan: NEEDS_YOU.plan,
          permission: NEEDS_YOU.permission,
          secret: NEEDS_YOU.secret,
          link: NEEDS_YOU.link,
        }[ask.kind];
  const placeholder =
    ask.kind === "question"
      ? NEEDS_YOU.questionNote
      : ask.kind === "plan"
        ? NEEDS_YOU.planNote
        : ask.kind === "secret"
          ? NEEDS_YOU.secretField
          : NEEDS_YOU.note;

  return (
    <Glass
      testID="needs-you"
      style={{ borderRadius: 24, padding: 4, maxHeight: "75%", flexShrink: 1 }}
    >
      <ScrollView
        style={{ flexShrink: 1 }}
        contentContainerStyle={{
          gap: 12,
          paddingTop: 10,
          paddingHorizontal: 12,
          paddingBottom: 12,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 9, minHeight: 24 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: brand.yuzu,
              boxShadow: "0 0 0 3px rgba(255,200,30,0.25)",
            }}
          />
          <Text
            testID="needs-you-header"
            accessibilityRole="header"
            accessibilityLabel={NEEDS_YOU.card(header)}
            numberOfLines={1}
            style={{
              flex: 1,
              fontFamily: font.sans,
              fontWeight: "600",
              fontSize: 15,
              color: color.ink,
            }}
          >
            {header}
          </Text>
          {pages.length > 1 ? <Pager at={at} count={pages.length} onGo={go} /> : null}
        </View>
        <PageBody
          key={keyOf(page)}
          page={page}
          draft={draft}
          disabled={disabled}
          onChoose={(label, multi) => {
            select();
            setDraft(choose(draft, label, multi));
          }}
          onOpenLink={onOpenLink}
          onOpenHandoff={(href) => {
            WebBrowser.openBrowserAsync(href).catch(() => {});
            setDraft({ ...draft, chosen: ["yes"] });
          }}
        />
      </ScrollView>
      {blocked !== null ? (
        <Text
          testID="needs-you-blocked"
          style={{
            fontFamily: font.sans,
            fontSize: 14,
            lineHeight: 20,
            color: color.muted,
            textAlign: "center",
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          {blocked}
        </Text>
      ) : (
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            gap: 8,
            borderRadius: 20,
            backgroundColor: color.card,
            paddingLeft: 14,
            paddingRight: 6,
            paddingVertical: 6,
          }}
        >
          <TextInput
            // One field per page: the words typed are that page's.
            key={keyOf(page)}
            testID="needs-you-note"
            accessibilityLabel={ask.kind === "secret" ? `The value of ${ask.name}` : "Note"}
            value={draft.note}
            editable={!busy && isOpen(ask)}
            onChangeText={(note) => setDraft({ ...draft, note })}
            placeholder={placeholder}
            placeholderTextColor={color.faint}
            multiline={ask.kind !== "secret"}
            submitBehavior="submit"
            returnKeyType="send"
            onSubmitEditing={advance}
            {...(ask.kind === "secret"
              ? {
                  // Never offered back by the keyboard, kept in its memory or shown.
                  secureTextEntry: true,
                  autoCapitalize: "none" as const,
                  autoCorrect: false,
                  spellCheck: false,
                  autoComplete: "off" as const,
                  textContentType: "none" as const,
                  importantForAutofill: "no" as const,
                }
              : {})}
            style={{
              flex: 1,
              maxHeight: 100,
              paddingVertical: 6,
              fontFamily: ask.kind === "secret" && draft.note ? font.mono : font.sans,
              fontSize: 16,
              lineHeight: 21,
              color: color.ink,
            }}
          />
          <Pressable
            testID="needs-you-send"
            accessibilityRole="button"
            accessibilityLabel={NEEDS_YOU.send}
            accessibilityState={{ disabled: !ready || busy, busy }}
            disabled={!ready || busy}
            hitSlop={6}
            onPress={advance}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: color.ink,
              alignItems: "center",
              justifyContent: "center",
              opacity: ready || busy ? 1 : 0.3,
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={color.bg} />
            ) : (
              <Send size={18} color={color.bg} />
            )}
          </Pressable>
        </View>
      )}
      {ask.kind === "secret" && blocked === null ? (
        <Text
          style={{
            fontFamily: font.sans,
            fontSize: 12,
            lineHeight: 16,
            color: color.faint,
            paddingHorizontal: 14,
            paddingTop: 6,
            paddingBottom: 4,
          }}
        >
          {NEEDS_YOU.secretKept(repoName)}
        </Text>
      ) : null}
    </Glass>
  );
}

function Pager({ at, count, onGo }: { at: number; count: number; onGo: (to: number) => void }) {
  const { color } = useTheme();
  const step = (testID: string, label: string, to: number, off: boolean, icon: ReactNode) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off }}
      disabled={off}
      hitSlop={8}
      onPress={() => onGo(to)}
      style={{
        width: 26,
        height: 26,
        alignItems: "center",
        justifyContent: "center",
        opacity: off ? 0.3 : 1,
      }}
    >
      {icon}
    </Pressable>
  );
  return (
    <View testID="needs-you-pager" style={{ flexDirection: "row", alignItems: "center" }}>
      {step(
        "needs-you-previous",
        NEEDS_YOU.previous,
        at - 1,
        at === 0,
        <Back size={14} color={color.muted} />,
      )}
      <Text
        accessibilityLabel={NEEDS_YOU.of(at + 1, count)}
        accessibilityLiveRegion="polite"
        style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}
      >
        {at + 1}/{count}
      </Text>
      {step(
        "needs-you-next",
        NEEDS_YOU.next,
        at + 1,
        at === count - 1,
        <View style={{ transform: [{ scaleX: -1 }] }}>
          <Back size={14} color={color.muted} />
        </View>,
      )}
    </View>
  );
}

function PageBody({
  page,
  draft,
  disabled,
  onChoose,
  onOpenLink,
  onOpenHandoff,
}: {
  page: Page;
  draft: Draft;
  disabled: boolean;
  onChoose: (value: string, multi: boolean) => void;
  onOpenLink: (url: string) => void;
  onOpenHandoff: (href: string) => void;
}) {
  const { color } = useTheme();
  const [whole, setWhole] = useState(false);
  const { ask } = page;
  const lead = {
    fontFamily: font.sans,
    fontWeight: "500",
    fontSize: 15,
    lineHeight: 21,
    color: color.ink,
  } as const;
  const quiet = {
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 18,
    color: color.muted,
  } as const;
  switch (ask.kind) {
    case "question": {
      const q = ask.questions[page.index]!;
      return (
        <View style={{ gap: 10 }}>
          <Text style={lead}>
            {q.question}
            {q.multiSelect ? (
              <Text style={{ fontWeight: "400", color: color.faint }}> {NEEDS_YOU.chooseAny}</Text>
            ) : null}
          </Text>
          <Options
            multi={q.multiSelect}
            options={q.options}
            chosen={draft.chosen}
            disabled={disabled}
            onChoose={(label) => onChoose(label, q.multiSelect)}
          />
        </View>
      );
    }
    case "plan":
    case "permission": {
      const choices = CHOICES[ask.kind];
      const plan = ask.kind === "plan" ? firstParagraph(ask.plan) : null;
      return (
        <View style={{ gap: 10 }}>
          {ask.kind === "plan" ? (
            <View
              testID="needs-you-plan"
              style={{ borderRadius: 14, backgroundColor: color.card, padding: 12, gap: 6 }}
            >
              <Markdown text={whole ? ask.plan : plan!.first} onOpenLink={onOpenLink} />
              {plan!.more && !whole ? (
                <Pressable
                  testID="needs-you-read-plan"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    tick();
                    setWhole(true);
                  }}
                >
                  <Text style={{ ...quiet, fontWeight: "600", color: color.ink }}>
                    {NEEDS_YOU.readPlan}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <View style={{ gap: 4 }}>
              <Text style={lead}>{ask.title}</Text>
              {ask.description ? <Text style={quiet}>{ask.description}</Text> : null}
              <Text style={{ ...quiet, fontFamily: font.mono, fontSize: 12, color: color.faint }}>
                {ask.tool}
              </Text>
            </View>
          )}
          <Options
            multi={false}
            options={(["yes", "no"] as const).map((value) => ({
              value,
              label: choices[value],
              description: choices.description?.[value] ?? "",
            }))}
            chosen={draft.chosen}
            disabled={disabled}
            onChoose={(value) => onChoose(value, false)}
          />
        </View>
      );
    }
    case "secret":
      return (
        <View style={{ gap: 4 }}>
          <Text style={lead}>{NEEDS_YOU.secretLead(ask.name)}</Text>
          {ask.description ? <Text style={quiet}>{ask.description}</Text> : null}
        </View>
      );
    case "link": {
      const href = webHref(ask.url);
      return (
        <View style={{ gap: 10 }}>
          <Text style={lead}>{ask.title}</Text>
          {ask.description ? <Text style={quiet}>{ask.description}</Text> : null}
          {href ? (
            <Options
              multi={false}
              options={[
                {
                  value: "yes",
                  label: NEEDS_YOU.open(hostOf(href)),
                  description: draft.chosen[0] === "yes" ? NEEDS_YOU.opened : href,
                },
                { value: "no", label: NEEDS_YOU.notNow, description: "" },
              ]}
              chosen={draft.chosen}
              disabled={disabled}
              onChoose={(value) => (value === "yes" ? onOpenHandoff(href) : onChoose("no", false))}
            />
          ) : (
            <View style={{ borderRadius: 14, backgroundColor: color.chip, padding: 10, gap: 2 }}>
              <Text style={quiet}>{NEEDS_YOU.notWeb}</Text>
              <Text style={{ ...quiet, fontFamily: font.mono, fontSize: 12, color: color.ink }}>
                {ask.url}
              </Text>
            </View>
          )}
        </View>
      );
    }
  }
}

/** The options, on one quiet track; the chosen raised, with a tick. */
function Options({
  multi,
  options,
  chosen,
  disabled,
  onChoose,
}: {
  multi: boolean;
  options: { label: string; description: string; value?: string }[];
  chosen: string[];
  disabled: boolean;
  onChoose: (value: string) => void;
}) {
  const { color, shadow } = useTheme();
  const valueFor = (o: (typeof options)[number]) => o.value ?? o.label;
  return (
    <View
      accessibilityRole={multi ? undefined : "radiogroup"}
      style={{
        borderRadius: 16,
        backgroundColor: color.chip,
        padding: 3,
        gap: 2,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {options.map((o) => {
        const on = chosen.includes(valueFor(o));
        return (
          <Pressable
            key={valueFor(o)}
            testID="needs-you-option"
            accessibilityRole={multi ? "checkbox" : "radio"}
            accessibilityLabel={o.description ? `${o.label}, ${o.description}` : o.label}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => onChoose(valueFor(o))}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              borderRadius: 13,
              paddingHorizontal: 12,
              paddingVertical: 8,
              backgroundColor: on ? color.card : "transparent",
              boxShadow: on ? shadow.pop : undefined,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                style={{
                  fontFamily: font.sans,
                  fontWeight: "500",
                  fontSize: 15,
                  lineHeight: 20,
                  color: color.ink,
                }}
              >
                {o.label}
              </Text>
              {o.description ? (
                <Text
                  numberOfLines={2}
                  style={{
                    fontFamily: font.sans,
                    fontSize: 13,
                    lineHeight: 18,
                    color: color.muted,
                  }}
                >
                  {o.description}
                </Text>
              ) : null}
            </View>
            {on ? <Check size={16} color={color.ink} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
