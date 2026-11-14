/*
 * A synthetic canvas of the founder's canvases' shape (counts only, none of their content), from
 * a fixed seed, as round 1 of the performance work measured it in headless Chrome
 * (.context/cloud/program/results/studio-performance-deep-dive.json): canvas A has 2 pages and
 * 6 boards (751 KB and 522 KB of node JSON, 85 box-shadows on the bigger, then four of 13 to
 * 36 KB) and 32 comment threads holding 34 messages; canvas B has 13 boards of 7 to 18 KB.
 */

type Text = { kind: "text"; value: string };
export type El = {
  kind: "el";
  id: string;
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  children: (El | Text)[];
};
export interface Board {
  id: string;
  name: string;
  x: number;
  y: number;
  root: El;
}
export interface SeedThread {
  artboardId: string;
  nodeId: string;
  x: number;
  y: number;
  messages: number;
}
export interface Synthetic {
  A: { page1: Board[]; page2: Board[]; threads: SeedThread[] };
  B: { page1: Board[] };
}

interface Budget {
  shadows: number;
  gradients: number;
  anims: number;
}

export function synthetic(): Synthetic {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  let ids = 0;
  const id = (p = "n") => `${p}_${(++ids).toString(36).padStart(8, "0")}`;
  const el = (tag: string, style: Record<string, string>, children: El["children"] = []): El => ({
    kind: "el",
    id: id(),
    tag,
    attrs: {},
    style,
    children,
  });
  const words =
    "plant shop order cart grow leaf light water soil pot ship care guide journal season return gift review price size fern moss stone clay".split(
      " ",
    );
  const sentence = (n: number) =>
    Array.from({ length: n }, () => pick(words))
      .join(" ")
      .replace(/^./, (c) => c.toUpperCase());
  const txt = (n: number): Text => ({ kind: "text", value: sentence(n) });
  const sans = "Inter, system-ui, sans-serif";
  const colors = [
    "#1f2a1d",
    "#4b5a46",
    "#f3efe6",
    "#ffffff",
    "#262b25",
    "#d9e4cf",
    "#9bb48a",
    "#e8e2d4",
  ];

  function card(b: Budget): El {
    const style: Record<string, string> = {
      display: "flex",
      "flex-direction": "column",
      gap: `${8 + Math.floor(rand() * 16)}px`,
      padding: `${16 + Math.floor(rand() * 24)}px`,
      "border-radius": `${8 + Math.floor(rand() * 12)}px`,
      background: pick(colors),
      color: pick(colors),
      border: `1px solid ${pick(colors)}`,
    };
    if (b.shadows > 0 && rand() < 0.5) {
      style["box-shadow"] =
        `0 ${1 + Math.floor(rand() * 8)}px ${4 + Math.floor(rand() * 24)}px rgba(0,0,0,0.${1 + Math.floor(rand() * 3)})`;
      b.shadows--;
    }
    if (b.anims > 0 && rand() < 0.05) {
      style[b.anims === 2 ? "animation" : "transition"] =
        b.anims === 2 ? "pz-pulse 2.4s ease-in-out infinite" : "transform 200ms ease-out";
      b.anims--;
    }
    const chips = Array.from({ length: 2 + Math.floor(rand() * 4) }, () =>
      el(
        "span",
        {
          padding: "4px 10px",
          "border-radius": "999px",
          background: pick(colors),
          font: `500 13px/1.2 ${sans}`,
        },
        [txt(1 + Math.floor(rand() * 2))],
      ),
    );
    const button = el(
      "a",
      {
        "align-self": "flex-start",
        padding: "12px 20px",
        "border-radius": "999px",
        font: `600 15px/1 ${sans}`,
        background: pick(colors),
        color: pick(colors),
      },
      [txt(2)],
    );
    if (b.gradients > 0 && rand() < 0.15) {
      button.style.background = `linear-gradient(135deg, ${pick(colors)}, ${pick(colors)})`;
      b.gradients--;
    }
    return el("div", style, [
      el("h3", { margin: "0", font: `600 ${18 + Math.floor(rand() * 10)}px/1.2 ${sans}` }, [
        txt(3 + Math.floor(rand() * 4)),
      ]),
      el("p", { margin: "0", font: `400 15px/1.5 ${sans}`, opacity: "0.8" }, [
        txt(12 + Math.floor(rand() * 20)),
      ]),
      el("div", { display: "flex", gap: "8px", "flex-wrap": "wrap" }, chips),
      button,
    ]);
  }

  function section(b: Budget): El {
    const cols = 2 + Math.floor(rand() * 3);
    const style: Record<string, string> = {
      display: "flex",
      "flex-direction": "column",
      gap: "32px",
      padding: "64px",
      background: pick(colors),
    };
    if (b.gradients > 0 && rand() < 0.3) {
      style.background = `radial-gradient(circle at ${Math.floor(rand() * 100)}% 30%, ${pick(colors)}, ${pick(colors)} 60%)`;
      b.gradients--;
    }
    return el("section", style, [
      el("h2", { margin: "0", font: "400 56px/1.05 Georgia, serif" }, [txt(5)]),
      el("p", { margin: "0", "max-width": "640px", font: `400 20px/1.5 ${sans}` }, [txt(24)]),
      el(
        "div",
        { display: "grid", "grid-template-columns": `repeat(${cols}, 1fr)`, gap: "24px" },
        Array.from({ length: cols * (1 + Math.floor(rand() * 2)) }, () => card(b)),
      ),
    ]);
  }

  /** A board whose node JSON is about `bytes` long. */
  function board(
    name: string,
    bytes: number,
    b: Budget,
    x: number,
    y: number,
    height?: number,
  ): Board {
    const root = el("main", {
      width: "1440px",
      ...(height ? { height: `${height}px`, overflow: "hidden" } : {}),
      background: "light-dark(#f3efe6, #1c211b)",
      color: "light-dark(#1f2a1d, #eef0e6)",
      display: "flex",
      "flex-direction": "column",
      "box-sizing": "border-box",
    });
    if (b.anims > 0) {
      root.children.push(
        el("style", {}, [
          { kind: "text", value: "@keyframes pz-pulse{0%,100%{opacity:1}50%{opacity:.6}}" },
        ]),
      );
    }
    while (JSON.stringify(root).length < bytes) {
      // Small boards take a card at a time, big ones a section.
      root.children.push(bytes > 60_000 ? section(b) : card(b));
    }
    return { id: root.id, name, x, y, root };
  }

  const nodesOf = (n: El, out: El[] = []): El[] => {
    out.push(n);
    for (const c of n.children) if (c.kind === "el") nodesOf(c, out);
    return out;
  };

  const none: Budget = { shadows: 0, gradients: 0, anims: 0 };
  const A1 = board("Home", 751_000, { shadows: 85, gradients: 19, anims: 2 }, 0, 0);
  const A2 = board("Product", 522_000, { shadows: 30, gradients: 6, anims: 0 }, 1640, 0);
  const A3 = board("Cart", 36_000, { ...none }, 3280, 0, 1100);
  const A4 = board("Empty", 13_000, { ...none }, 4920, 0, 900);
  const A5 = board("Settings", 24_000, { ...none }, 0, 0, 1000);
  const A6 = board("Mobile", 18_000, { ...none }, 1640, 0, 900);

  // 32 threads, 34 messages: most on the two big boards, on a node, a few on the small ones.
  const threads: SeedThread[] = [];
  for (let i = 0; i < 32; i++) {
    const ab = i < 14 ? A1 : i < 24 ? A2 : pick([A3, A4, A5, A6]);
    const node = pick(nodesOf(ab.root));
    threads.push({
      artboardId: ab.id,
      nodeId: node.id,
      x: Math.floor(rand() * 1300),
      y: Math.floor(rand() * 900),
      messages: i < 2 ? 2 : 1,
    });
  }

  const B = Array.from({ length: 13 }, (_, i) =>
    board(
      `B${i + 1}`,
      7_000 + Math.floor(rand() * 11_000),
      { ...none },
      (i % 5) * 1640,
      Math.floor(i / 5) * 1200,
      1000,
    ),
  );

  return { A: { page1: [A1, A2, A3, A4], page2: [A5, A6], threads }, B: { page1: B } };
}
