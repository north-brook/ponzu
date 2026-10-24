# Decisions

- **Inside an artboard: C** ("one big write, in yuzu"). Paper's two-beat develop with yuzu (#f2b100) outlines. Per piece: outlines over 0–600ms, held to 780, gone by 1040. Veil opaque to 600, gone by 1300. Pieces stagger 55ms, capped at 10. Veil uses the nearest filled ancestor's color. No translate.
- **Disk writes animate too.** Bryce wants bulk writes and direct filesystem saves to arrive the same way. Plan: animate disk-origin `children` and `artboard.create` ops, only for elements whose ids are new (carryIds keeps unchanged ids), so small edits don't replay the whole board.
  - Open: do Bryce's own editor saves animate, or only when an agent is present?
- **Artboard arrival: D family** (draw the frame). Liked over E and F.
- **Working indicator: D3**, a rounded yuzu ring 4px off the edge (r 8) that breathes 1→2px with a 4→10px glow on a 3s beat, then fades 500ms after the agent stops. It replaces the marching-dash trace. Later edits light the same ring.
- **Artboards get a slight radius: 4px.**
- **Header: G, yuzu rain** to the right of the name, no agent mark. Who and their status are in its tooltip. The name no longer shimmers.
