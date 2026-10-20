/**
 * The "Just HTML and CSS" tile. The page applies this stylesheet and prints it beside the result,
 * so the code you read is the code that runs.
 */
export const SLICE_CSS = `.cit-wheel {
  animation: turn 20s linear infinite;
}
.cit-seg {
  animation: pop 3.2s infinite both
    calc(var(--i) * .15s);
}
@keyframes turn {
  to { rotate: 1turn }
}
@keyframes pop {
  0%, 90% { scale: 0 }
  14% { scale: 1.1 }
  24%, 66% { scale: 1 }
}`;
