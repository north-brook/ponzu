import { PlusSignIcon } from "@hugeicons/core-free-icons";
import type { KeyboardEvent, Ref } from "react";
import { IconButton, SendButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { canSend } from "./create.ts";
import { type ModelChoice, ModelPicker } from "./model-picker.tsx";

/**
 * The new design's prompt: one white card with the text, attach, the model and send. Return
 * sends and Shift-Return breaks the line; send waits until there is something to send. The
 * field grows with the prompt, then scrolls.
 */
export function NewDesignComposer({
  prompt,
  onPromptChange,
  onSend,
  onAttach,
  sending = false,
  model,
  fieldRef,
}: {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  onAttach: () => void;
  sending?: boolean;
  model: ModelChoice;
  fieldRef?: Ref<HTMLTextAreaElement>;
}) {
  const ready = canSend(prompt, sending);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (ready) onSend();
  };

  return (
    <div className="flex min-h-[118px] flex-col gap-[18px] rounded-20 bg-surface pt-4 pr-2.5 pb-2.5 pl-[18px] shadow-bar">
      <textarea
        ref={fieldRef}
        aria-label="Describe the design"
        placeholder="Describe a screen, a flow or a brand"
        rows={1}
        value={prompt}
        onChange={(e) => onPromptChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="max-h-60 resize-none bg-transparent pr-2 text-16 text-ink leading-[1.5] outline-none [caret-color:var(--c-ink)] [field-sizing:content] placeholder:text-faint"
      />
      <span className="flex-1" />
      <div className="-ml-2 flex items-center gap-1.5">
        <IconButton
          label="Attach"
          tipSide="top"
          onClick={onAttach}
          className="size-[30px] rounded-pill"
        >
          <Icon icon={PlusSignIcon} size={16} stroke={1.9} />
        </IconButton>
        <span className="flex-1" />
        <ModelPicker {...model} />
        <SendButton
          size={32}
          iconSize={15}
          disabled={!ready}
          aria-busy={sending || undefined}
          onClick={onSend}
        />
      </div>
    </div>
  );
}
