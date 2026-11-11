/*
 * A tool call's input as the model writes it, read before it is finished: the members that are
 * complete so far, as an object. The working state names what a call is on (the file, the
 * board, the command) from these, while the rest (a board's HTML, a file's contents) is still
 * being written. Fed a piece at a time; each character is looked at once.
 */

/** How much of an input is kept to read: the keys that name things come first. */
const KEEP = 64_000;
/** Below this, a member completed inside a nested value is worth a look too (`updates[0].id`). */
const NESTED = 4_000;

export class PartialInput {
  private text = "";
  /** Containers open at the end of `text`: `{` or `[`. */
  private stack: string[] = [];
  private inString = false;
  private escaped = false;
  private stringIsKey = false;
  /** The last thing outside a string: `{`, `[`, `,`, `:` or a value's end. */
  private prev = "";
  /** The end of the last complete member, and the containers open there. */
  private safe = 0;
  private safeStack = "";
  /** Whether `safe` moved since the input was last read. */
  private moved = false;

  /** Takes the next piece. True when more of the input can be read than before. */
  feed(chunk: string): boolean {
    if (this.text.length >= KEEP) return false;
    const from = this.text.length;
    this.text += chunk.slice(0, KEEP - from);
    for (let i = from; i < this.text.length; i++) this.step(this.text[i]!, i);
    const worth = this.moved && (this.safeStack.length <= 1 || this.safe <= NESTED);
    if (worth) this.moved = false;
    return worth;
  }

  /** The input's complete members so far, or null before the first. */
  value(): Record<string, unknown> | null {
    if (!this.safe) return null;
    const closers = [...this.safeStack]
      .reverse()
      .map((c) => (c === "{" ? "}" : "]"))
      .join("");
    try {
      const parsed = JSON.parse(this.text.slice(0, this.safe) + closers);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private step(c: string, i: number): void {
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (c === "\\") this.escaped = true;
      else if (c === '"') {
        this.inString = false;
        this.prev = '"';
        if (!this.stringIsKey) this.mark(i + 1);
      }
      return;
    }
    switch (c) {
      case '"': {
        const top = this.stack.at(-1);
        this.inString = true;
        this.stringIsKey = top === "{" && (this.prev === "{" || this.prev === ",");
        return;
      }
      case "{":
      case "[":
        this.stack.push(c);
        this.prev = c;
        return;
      case "}":
      case "]":
        // A number, true, false or null ends where its container does.
        if (this.afterPrimitive()) this.mark(i);
        this.stack.pop();
        this.prev = c;
        if (this.stack.length) this.mark(i + 1);
        return;
      case ",":
        if (this.afterPrimitive()) this.mark(i);
        this.prev = c;
        return;
      case ":":
        this.prev = c;
        return;
      default:
        if (!/\s/.test(c)) this.prev = c;
    }
  }

  /** Whether a number or literal has just been written: strings and containers mark their own end. */
  private afterPrimitive(): boolean {
    return !['"', "}", "]", "{", "[", ",", ":", ""].includes(this.prev);
  }

  private mark(at: number): void {
    if (!this.stack.length) return;
    this.safe = at;
    this.safeStack = this.stack.join("");
    this.moved = true;
  }
}
