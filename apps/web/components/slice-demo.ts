/**
 * The "Just HTML and CSS" tile. The page applies this stylesheet and prints it beside the result,
 * so the code you read is the code that runs.
 */
export const SLICE_CSS = `.cit-seg {
  transform-origin: 32px 32px;
  animation: bloom 3.2s infinite both
    calc(var(--i) * 50ms);
}
@keyframes bloom {
  0%, 100% { scale: 0; rotate: -60deg }
  22%, 68% { scale: 1; rotate: 0deg }
}`;
