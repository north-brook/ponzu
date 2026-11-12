import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { type KeyboardEvent, type Ref, useId } from "react";
import type { PendingAttachment } from "../model.ts";
import { AttachmentChip } from "../thread/composer.tsx";
import { IconButton, SendButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { FIELD, pressToFocus } from "../ui/press-to-focus.ts";
import { canSend } from "./create.ts";
import { type Suggestion, SuggestionLine } from "./ideas.tsx";
import { type ModelChoice, ModelPicker } from "./model-picker.tsx";

/**
 * The new design's prompt: one white card with the text, attach, the model and send. Return
 * sends and Shift-Return breaks the line; send waits until there is something to send. The
 * field grows with the prompt, then scrolls.
 *
 * While the field is empty and there is a `suggestion` (an idea for the chosen repo), it shows
 * as the placeholder, each idea taking its turn; Tab takes the one showing into the field, to
 * edit and send. Typing anything puts it away, and Tab is the keyboard's again.
 */
export function NewDesignComposer({
  prompt,
  onPromptChange,
  onSend,
  onAttach,
  sending = false,
  model,
  fieldRef,
  attachments = [],
  onRemoveAttachment,
  suggestion = null,
  onAcceptSuggestion,
}: {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  onAttach: () => void;
  sending?: boolean;
  /** Null hides the picker: the person's defaults aren't known yet, and the API applies them. */
  model: ModelChoice | null;
  fieldRef?: Ref<HTMLTextAreaElement>;
  /** Images to send with the prompt, above the field. */
  attachments?: PendingAttachment[];
  onRemoveAttachment?: (id: string) => void;
  /** The idea to show as the placeholder while the field is empty. */
  suggestion?: Suggestion | null;
  /** Tab on the empty field: the suggestion showing goes into it. */
  onAcceptSuggestion?: (suggestion: Suggestion) => void;
}) {
  const ready = canSend(prompt, sending);
  const suggested = prompt === "" ? suggestion : null;
  const described = useId();

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Tab" &&
      suggested &&
      !(e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      onAcceptSuggestion?.(suggested);
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (ready) onSend();
  };

  return (
    // The whole card is the field's: a press on it, past its controls, writes.
    <div
      onMouseDown={pressToFocus}
      className="flex min-h-[118px] cursor-text flex-col gap-[18px] rounded-20 bg-surface pt-4 pr-2.5 pb-2.5 pl-[18px] shadow-bar"
    >
      {attachments.length ? (
        <ul
          aria-label="Attached images"
          className="m-0 -mb-1.5 flex list-none flex-wrap gap-1.5 p-0"
        >
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              onRemove={() => onRemoveAttachment?.(attachment.id)}
              onRetry={() => {}}
            />
          ))}
        </ul>
      ) : null}
      <div className="relative flex flex-col">
        <textarea
          ref={fieldRef}
          {...FIELD}
          aria-label="Describe the design"
          aria-describedby={suggested ? described : undefined}
          placeholder="Describe a screen, a flow or a brand"
          rows={1}
          value={prompt}
          onChange={(e) => onPromptChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "max-h-60 resize-none bg-transparent pr-2 text-16 text-ink leading-[1.5] outline-none [caret-color:var(--c-ink)] [field-sizing:content]",
            // The suggestion stands where the placeholder would: the placeholder's own words
            // stay for assistive tech, unseen.
            suggested ? "placeholder:text-transparent" : "placeholder:text-faint",
          )}
        />
        {suggested ? (
          <>
            <SuggestionLine suggestion={suggested} />
            {/* The same words for assistive tech, and as private: masked in a recording. */}
            <span id={described} data-replay="mask" className="sr-only">
              Suggestion: {suggested.idea.prompt}. Press Tab to use it.
            </span>
          </>
        ) : null}
      </div>
      <span className="flex-1" />
      <div className="-ml-2 flex items-center gap-1.5">
        <IconButton
          label="Attach"
          tipSide="top"
          onClick={onAttach}
          className="size-[30px] rounded-pill"
        >
          <Icon icon={PlusSignIcon} step="control" />
        </IconButton>
        <span className="flex-1" />
        {model ? <ModelPicker {...model} /> : null}
        <SendButton size={32} disabled={!ready} aria-busy={sending || undefined} onClick={onSend} />
      </div>
    </div>
  );
}
