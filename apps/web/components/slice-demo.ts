/**
 * The "Just HTML and CSS" tile. The page applies this stylesheet and prints it beside the result,
 * so the code you read is the code that runs. It's the brand's Bloom enter and exit: segments
 * spin up into place one after another, hold, then carry on round the same way and out.
 */
export const SLICE_CSS = `.cit-seg {
  transform-origin: 32px 32px;
  animation: bloom 3.2s infinite both
    cubic-bezier(.2, .8, .2, 1)
    calc(var(--i) * 50ms);
}
@keyframes bloom {
  from { scale: 0; rotate: -60deg }
  22%, 68% { scale: 1; rotate: 0deg }
  90%, to { scale: 0; rotate: 60deg }
}`;
