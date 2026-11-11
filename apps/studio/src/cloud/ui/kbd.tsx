/** A key or shortcut named in passing, as quiet text: "⌘," in a menu, "esc" in the search field. */
export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="shrink-0 font-normal font-sans text-11 text-faint leading-none">{children}</kbd>
  );
}
