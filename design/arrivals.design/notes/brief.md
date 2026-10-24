# Arrivals

Bryce finds Paper's agent arrival animation more polished and more "magical" than ours (the shimmer slide in packages/react/src/arrive.ts). We're iterating on a replacement here.

## Paper, from its bundle (app.paper.design main-*.js)
- `B8` config: read 1500ms up/fullCover α.7 · write 1500ms down/fullCover α1 · edit 1000ms postChange α.5 · delete 800ms postChange α.8
- write: node hidden (visibility) until 50%; canvas overlay in nearest filled ancestor's average color ramps to peak over the first half, then gradient sweeps down and fades
- outlines (write/edit): node + up to 5 descendants, stagger over first half, 100ms in, hold to half+200, 300ms out, in agent color
- working artboard: 2px stroke, alpha 1→.2→1 on a 3s cycle, 400ms in/out; plus a 32-column "rain" of dots by the label
- all drawn on a HUD canvas; `reduceAgentAnimations` user setting

## Boards
- ab_pnjz6 ours today · ab_6xgga Paper rebuilt · ab_0l9zq A: develop in yuzu · ab_e2vkc B: blueprint then shimmer
- Generator script: /tmp/arrivals-gen/gen.ts (regenerates all four looping demos)
