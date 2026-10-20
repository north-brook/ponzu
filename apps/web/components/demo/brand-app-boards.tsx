import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Arrow, Bag, C, MONO, Photo, Root, SERIF } from "./boards";

// Fernwood's Brand page (logo, color & type) and App page (three iOS screens).
// Same rules as boards.tsx: fixed-size presentational artboards, with `data-r`
// marking the order Claude writes each piece.

// ---------------------------------------------------------------------------
// Shared

const PAPER = "#faf6ef";
const POT = { bone: "#ece4d6", clay: "#d49a78", sage: "#b7c6ae" };

const mono = (color: string, size = 11): CSSProperties => ({
  fontFamily: MONO,
  fontSize: size,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color,
});

const em: CSSProperties = { fontStyle: "italic", letterSpacing: "-0.02em" };

// The Fernwood frond, redrawn: the same four tapering leaflet pairs and bud as
// the landing pages' mark, with pointed leaves and a hair of air at the stem.
const LEAVES = [8, 13, 18, 23].map((y, i) => ({ y, l: 11.4 - i * 1.7, h: 2.7 - i * 0.18 }));

function leaf(l: number, h: number) {
  return `M0 0C${l * 0.22} ${-h} ${l * 0.62} ${-h * 1.05} ${l} 0C${l * 0.62} ${h * 0.95} ${l * 0.22} ${h * 0.9} 0 0Z`;
}

export function FernMark({ color, size = 32 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M16 30.2V6.5" stroke={color} strokeWidth="2.1" strokeLinecap="round" />
      <g fill={color}>
        {LEAVES.map(({ y, l, h }) => (
          <g key={y}>
            <path d={leaf(l, h)} transform={`translate(16.9 ${y - l * 0.2}) rotate(26)`} />
            <path
              d={leaf(l, h)}
              transform={`translate(15.1 ${y - l * 0.2}) scale(-1 1) rotate(26)`}
            />
          </g>
        ))}
        <path d="M16 0.6C17.7 2.6 18.3 4.4 16 7.4 13.7 4.4 14.3 2.6 16 0.6Z" />
      </g>
    </svg>
  );
}

function Wordmark({ color, size }: { color: string; size: number }) {
  return (
    <span
      style={{
        fontFamily: SERIF,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: "-0.025em",
        color,
        whiteSpace: "nowrap",
      }}
    >
      Fernwood
    </span>
  );
}

function Lockup({
  color,
  mark,
  size,
  stacked = false,
}: {
  color: string;
  mark: string;
  size: number;
  stacked?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: "center",
        gap: stacked ? size * 0.22 : size * 0.16,
      }}
    >
      <FernMark color={mark} size={stacked ? size * 1.25 : size * 0.98} />
      <Wordmark color={color} size={size} />
    </div>
  );
}

function AppIcon({ size }: { size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.2237,
        background: `radial-gradient(120% 90% at 30% 10%, #1d3a29, ${C.forest} 60%)`,
        display: "grid",
        placeItems: "center",
        boxShadow: `0 ${size * 0.12}px ${size * 0.3}px -${size * 0.12}px rgb(12 26 18 / 0.55)`,
      }}
    >
      <FernMark color={C.lime} size={size * 0.62} />
    </div>
  );
}

function Tile({
  r,
  x,
  y,
  w,
  h,
  bg,
  children,
}: {
  r: number;
  x: number;
  y: number;
  w: number;
  h: number;
  bg: string;
  children: ReactNode;
}) {
  return (
    <div
      data-r={r}
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: 22,
        background: bg,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function TileLabel({
  color,
  children,
  right,
}: {
  color: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 22,
        right: 22,
        top: 20,
        display: "flex",
        justifyContent: "space-between",
        ...mono(color, 10.5),
      }}
    >
      <span>{children}</span>
      {right && <span>{right}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand 1. Logo: the identity as one sheet.

export function LogoBoard() {
  const ticks: CSSProperties[] = [
    { left: 0, top: 0, borderLeftWidth: 3, borderTopWidth: 3 },
    { right: 0, top: 0, borderRightWidth: 3, borderTopWidth: 3 },
    { left: 0, bottom: 0, borderLeftWidth: 3, borderBottomWidth: 3 },
    { right: 0, bottom: 0, borderRightWidth: 3, borderBottomWidth: 3 },
  ];
  const specs = [
    ["Mark", "The frond · 4 pairs"],
    ["Wordmark", "Instrument Serif"],
    ["Minimum", "Mark 16 px · Lockup 96 px"],
  ];
  const strip = [
    { c: C.forest, f: 4 },
    { c: C.cream, f: 2.4 },
    { c: C.lime, f: 1.4 },
    { c: C.terracotta, f: 1 },
    { c: C.sage, f: 1 },
  ];
  return (
    <Root width={1200} height={800} background="#e9e1d3" color={C.ink}>
      {/* Primary lockup on forest */}
      <div
        style={{
          position: "absolute",
          left: 28,
          top: 28,
          width: 700,
          height: 744,
          borderRadius: 22,
          background: `radial-gradient(90% 70% at 50% 42%, #18301f, ${C.forest} 70%)`,
          overflow: "hidden",
        }}
      >
        <div data-r={1}>
          <TileLabel color="rgb(244 239 230 / 0.5)" right="2026">
            Fernwood · Identity
          </TileLabel>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 272,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <Lockup color={C.cream} mark={C.lime} size={118} />
          </div>
        </div>

        <div data-r={2}>
          {/* clearspace: half a mark on every side */}
          <div style={{ position: "absolute", left: 62, top: 208, width: 576, height: 246 }}>
            {ticks.map((t) => (
              <span
                key={`${t.left ?? "r"}-${t.top ?? "b"}`}
                style={{
                  position: "absolute",
                  width: 26,
                  height: 26,
                  borderStyle: "solid",
                  borderWidth: 0,
                  borderColor: "rgb(201 242 122 / 0.55)",
                  ...t,
                }}
              />
            ))}
            <span
              style={{
                position: "absolute",
                left: "50%",
                top: -30,
                translate: "-50% 0",
                ...mono("rgb(201 242 122 / 0.7)", 10.5),
              }}
            >
              ½ × mark
            </span>
          </div>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 500,
              textAlign: "center",
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 30,
              color: "rgb(244 239 230 / 0.6)",
            }}
          >
            Plants that outlive your lease.
          </div>
          <div
            style={{
              position: "absolute",
              left: 28,
              right: 28,
              bottom: 26,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1.3fr",
              gap: 16,
              paddingTop: 18,
              borderTop: "1.5px solid rgb(244 239 230 / 0.14)",
            }}
          >
            {specs.map(([k, v]) => (
              <div key={k}>
                <div style={mono("rgb(244 239 230 / 0.45)", 10)}>{k}</div>
                <div style={{ marginTop: 6, fontSize: 15, fontWeight: 500, color: C.cream }}>
                  {v}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Stacked on lime */}
      <Tile r={3} x={744} y={28} w={428} h={300} bg={C.lime}>
        <TileLabel color="rgb(18 36 26 / 0.55)">Stacked</TileLabel>
        <div
          style={{ position: "absolute", inset: "44px 0 0", display: "grid", placeItems: "center" }}
        >
          <Lockup color={C.forest} mark={C.forest} size={62} stacked />
        </div>
      </Tile>

      {/* Mark alone on terracotta */}
      <Tile r={4} x={744} y={344} w={206} h={212} bg={C.terracotta}>
        <TileLabel color="rgb(244 239 230 / 0.6)">Mark</TileLabel>
        <div
          style={{ position: "absolute", inset: "30px 0 0", display: "grid", placeItems: "center" }}
        >
          <FernMark color={C.cream} size={112} />
        </div>
      </Tile>

      {/* App icon + favicons */}
      <Tile r={5} x={966} y={344} w={206} h={212} bg={PAPER}>
        <TileLabel color={C.muted}>App icon</TileLabel>
        <div
          style={{
            position: "absolute",
            left: 22,
            bottom: 24,
            display: "flex",
            alignItems: "flex-end",
            gap: 14,
          }}
        >
          <AppIcon size={104} />
          <div
            style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}
          >
            <AppIcon size={36} />
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 20,
                height: 20,
                borderRadius: 5,
                background: C.lime,
              }}
            >
              <FernMark color={C.forest} size={16} />
            </span>
          </div>
        </div>
      </Tile>

      {/* Reversed, with the palette in proportion */}
      <Tile r={6} x={744} y={572} w={428} h={200} bg={PAPER}>
        <TileLabel color={C.muted} right="On paper">
          Reversed
        </TileLabel>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 74,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <Lockup color={C.forest} mark={C.terracotta} size={56} />
        </div>
        <div
          style={{
            position: "absolute",
            left: 22,
            right: 22,
            bottom: 22,
            height: 22,
            display: "flex",
            borderRadius: 7,
            overflow: "hidden",
            boxShadow: "inset 0 0 0 1px rgb(15 26 19 / 0.06)",
          }}
        >
          {strip.map((s) => (
            <span key={s.c} style={{ flex: s.f, background: s.c }} />
          ))}
        </div>
      </Tile>
    </Root>
  );
}

// ---------------------------------------------------------------------------
// Brand 2. Color & Type: the palette sized by how much of it we use.

const palette = () => [
  { name: "Forest", role: "Ground", hex: "#12241A", bg: C.forest, ink: C.cream, f: 3.4 },
  { name: "Cream", role: "Paper", hex: "#F4EFE6", bg: C.cream, ink: C.ink, f: 2.2 },
  { name: "Lime", role: "Signal", hex: "#C9F27A", bg: C.lime, ink: C.ink, f: 1.5 },
  { name: "Terracotta", role: "Warmth", hex: "#C2603A", bg: C.terracotta, ink: C.cream, f: 1.3 },
  { name: "Sage", role: "Leaf", hex: "#C8D5C0", bg: C.sage, ink: C.ink, f: 1.1 },
];

export function PaletteBoard() {
  const pots = [
    { name: "Bone", c: POT.bone },
    { name: "Clay", c: POT.clay },
    { name: "Sage", c: POT.sage },
  ];
  return (
    <Root width={1200} height={800} background={PAPER} color={C.ink}>
      <div
        data-r={1}
        style={{
          position: "absolute",
          left: 40,
          right: 40,
          top: 34,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 1, letterSpacing: "-0.02em" }}>
          Color <span style={{ ...em, color: C.terracotta }}>&amp;</span> Type
        </span>
        <span style={mono(C.muted, 11)}>Width = share of every layout</span>
      </div>

      <div
        data-r={2}
        style={{
          position: "absolute",
          left: 40,
          right: 40,
          top: 100,
          height: 330,
          display: "flex",
          gap: 10,
        }}
      >
        {palette().map((p) => (
          <div
            key={p.name}
            style={{
              flex: p.f,
              position: "relative",
              borderRadius: 20,
              background: p.bg,
              color: p.ink,
              boxShadow: p.name === "Cream" ? "inset 0 0 0 1.5px rgb(15 26 19 / 0.08)" : "none",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 20,
                top: 18,
                ...mono(p.ink, 10.5),
                opacity: 0.6,
              }}
            >
              {p.role}
            </span>
            <div style={{ position: "absolute", left: 20, right: 16, bottom: 20 }}>
              <div
                style={{ fontFamily: SERIF, fontSize: 36, lineHeight: 1, letterSpacing: "-0.02em" }}
              >
                {p.name}
              </div>
              <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 13, opacity: 0.7 }}>
                {p.hex}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Display */}
      <div
        data-r={3}
        style={{
          position: "absolute",
          left: 40,
          top: 456,
          width: 500,
          height: 304,
          borderRadius: 20,
          background: C.forest,
          color: C.cream,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 24,
            top: 20,
            ...mono("rgb(244 239 230 / 0.5)", 10.5),
          }}
        >
          Display · Instrument Serif
        </span>
        <div
          style={{
            position: "absolute",
            left: 18,
            top: 30,
            fontFamily: SERIF,
            fontSize: 210,
            lineHeight: 1,
            letterSpacing: "-0.04em",
          }}
        >
          A<span style={{ ...em, color: C.lime }}>a</span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 260,
            right: 24,
            top: 92,
            fontFamily: SERIF,
            fontSize: 38,
            lineHeight: 0.98,
            letterSpacing: "-0.02em",
          }}
        >
          Plants that <span style={{ ...em, color: C.lime }}>outlive</span> your lease.
        </div>
        <div
          style={{
            position: "absolute",
            left: 24,
            right: 24,
            bottom: 20,
            display: "flex",
            justifyContent: "space-between",
            ...mono("rgb(244 239 230 / 0.5)", 10.5),
          }}
        >
          <span>Headlines · plant names · prices</span>
          <span>Italic for one word</span>
        </div>
      </div>

      {/* Text */}
      <div
        data-r={4}
        style={{
          position: "absolute",
          left: 556,
          top: 456,
          width: 330,
          height: 304,
          borderRadius: 20,
          background: C.cream,
          overflow: "hidden",
        }}
      >
        <span style={{ position: "absolute", left: 24, top: 20, ...mono(C.muted, 10.5) }}>
          Text · Inter
        </span>
        <div style={{ position: "absolute", left: 24, right: 24, top: 56 }}>
          {[
            { w: 700, s: 30, t: "Water today" },
            { w: 600, s: 22, t: "3 plants are thirsty" },
            { w: 500, s: 17, t: "Bright, indirect light" },
          ].map((row) => (
            <div
              key={row.w}
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 10,
                paddingBottom: 10,
                marginBottom: 10,
                borderBottom: "1.5px solid rgb(15 26 19 / 0.08)",
              }}
            >
              <span
                style={{
                  fontWeight: row.w,
                  fontSize: row.s,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.1,
                }}
              >
                {row.t}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{row.w}</span>
            </div>
          ))}
          <p style={{ margin: "4px 0 0", fontSize: 14.5, lineHeight: 1.5, color: C.muted }}>
            Care guides written by people who actually water things. Plain verbs, sentence case.
          </p>
        </div>
      </div>

      {/* Labels + pots */}
      <div
        data-r={5}
        style={{
          position: "absolute",
          left: 902,
          top: 456,
          width: 258,
          height: 144,
          borderRadius: 20,
          background: C.sage,
          overflow: "hidden",
        }}
      >
        <span
          style={{ position: "absolute", left: 22, top: 20, ...mono("rgb(15 26 19 / 0.6)", 10.5) }}
        >
          Labels · JetBrains Mono
        </span>
        <div
          style={{
            position: "absolute",
            left: 22,
            right: 22,
            bottom: 20,
            display: "grid",
            gridTemplateColumns: "64px 1fr",
            rowGap: 8,
            fontFamily: MONO,
            fontSize: 12.5,
          }}
        >
          <span style={{ opacity: 0.55 }}>LIGHT</span>
          <span>Bright, indirect</span>
          <span style={{ opacity: 0.55 }}>WATER</span>
          <span>Every 7–10 days</span>
        </div>
      </div>

      <div
        data-r={6}
        style={{
          position: "absolute",
          left: 902,
          top: 616,
          width: 258,
          height: 144,
          borderRadius: 20,
          background: C.clay,
          overflow: "hidden",
        }}
      >
        <span
          style={{ position: "absolute", left: 22, top: 20, ...mono("rgb(15 26 19 / 0.6)", 10.5) }}
        >
          Pots you'll keep
        </span>
        <div
          style={{
            position: "absolute",
            left: 22,
            right: 22,
            bottom: 18,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          {pots.map((p) => (
            <div key={p.name} style={{ textAlign: "center" }}>
              {/* a little cylinder pot */}
              <div style={{ position: "relative", width: 58, height: 56, margin: "0 auto" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: 6,
                    bottom: 0,
                    borderRadius: "6px 6px 14px 14px",
                    background: `linear-gradient(90deg, rgb(0 0 0 / 0.06), transparent 40%, rgb(255 255 255 / 0.18) 62%, rgb(0 0 0 / 0.08)), ${p.c}`,
                  }}
                />
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: 0,
                    height: 12,
                    borderRadius: 999,
                    background: p.c,
                    boxShadow: "inset 0 -4px 0 rgb(60 40 25 / 0.35)",
                  }}
                />
              </div>
              <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600 }}>{p.name}</div>
            </div>
          ))}
        </div>
      </div>
    </Root>
  );
}

// ---------------------------------------------------------------------------
// App: one native iOS app. 24 px margins, 22 px cards, a floating forest tab bar.

const CARD = "#fbf8f2";
const HAIR = "inset 0 0 0 1.5px rgb(15 26 19 / 0.07)";

function StatusBar({ ink }: { ink: string }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 50,
        padding: "0 30px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 16,
        fontWeight: 600,
        color: ink,
      }}
    >
      <span>9:41</span>
      <span style={{ display: "flex", gap: 6, alignItems: "center", opacity: 0.9 }}>
        <span style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height: 11 }}>
          {[4, 6, 8.5, 11].map((h) => (
            <span key={h} style={{ width: 3, height: h, borderRadius: 1, background: ink }} />
          ))}
        </span>
        <span
          style={{
            width: 25,
            height: 12,
            borderRadius: 4,
            border: `1.5px solid ${ink}`,
            padding: 1.5,
          }}
        >
          <span
            style={{
              display: "block",
              width: "75%",
              height: "100%",
              borderRadius: 2,
              background: ink,
            }}
          />
        </span>
      </span>
    </div>
  );
}

type Tab = "today" | "plants" | "shop" | "journal";

function TabIcon({ tab, color }: { tab: Tab; color: string }) {
  const s = { stroke: color, strokeWidth: 1.9, fill: "none", strokeLinecap: "round" } as const;
  if (tab === "plants") return <FernMark color={color} size={22} />;
  if (tab === "shop") return <Bag color={color} size={21} />;
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      {tab === "today" && (
        <>
          <circle cx="12" cy="12" r="4.2" {...s} />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <path key={a} d="M12 2.6v2.2" {...s} transform={`rotate(${a} 12 12)`} />
          ))}
        </>
      )}
      {tab === "journal" && (
        <>
          <path d="M6 3.8h11a1.5 1.5 0 0 1 1.5 1.5v14.9H7.5A2 2 0 0 1 5.5 18.2V4.3" {...s} />
          <path d="M9.5 8.5h5.5M9.5 12h4" {...s} />
        </>
      )}
    </svg>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "plants", label: "Plants" },
  { id: "shop", label: "Shop" },
  { id: "journal", label: "Journal" },
];

function TabBar({ active, r }: { active: Tab; r: number }) {
  return (
    <div
      data-r={r}
      style={{
        position: "absolute",
        left: 20,
        right: 20,
        bottom: 26,
        height: 66,
        padding: "0 9px",
        borderRadius: 999,
        background: C.forest,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: "0 18px 36px -16px rgb(12 26 18 / 0.6)",
      }}
    >
      {TABS.map((t) =>
        t.id === active ? (
          <span
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 48,
              padding: "0 20px 0 16px",
              borderRadius: 999,
              background: C.lime,
              color: C.ink,
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            <TabIcon tab={t.id} color={C.ink} />
            {t.label}
          </span>
        ) : (
          <span
            key={t.id}
            style={{ display: "grid", placeItems: "center", width: 60, height: 48, opacity: 0.62 }}
          >
            <TabIcon tab={t.id} color={C.cream} />
          </span>
        ),
      )}
    </div>
  );
}

function Check({ done }: { done: boolean }) {
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        width: 34,
        height: 34,
        flexShrink: 0,
        borderRadius: 999,
        background: done ? C.forest : "transparent",
        boxShadow: done ? "none" : "inset 0 0 0 2px rgb(15 26 19 / 0.2)",
      }}
    >
      {done && (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="m4.5 10.5 3.6 3.5 7.4-8"
            stroke={C.lime}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

function RoundButton({ children, bg }: { children: ReactNode; bg: string }) {
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        width: 44,
        height: 44,
        borderRadius: 999,
        background: bg,
        boxShadow: "0 1px 2px rgb(15 26 19 / 0.08)",
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// App 1. Today

const TASKS = [
  { name: "Pip", kind: "Pilea", amount: "250 ml", src: "/demo/pilea.webp", done: true },
  { name: "Olive", kind: "Monstera", amount: "400 ml", src: "/demo/monstera.webp", done: false },
  { name: "Stanley", kind: "Snake plant", amount: "150 ml", src: "/demo/snake.webp", done: false },
];

export function AppTodayBoard() {
  const week = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  return (
    <Root width={390} height={844} background={C.cream} color={C.ink}>
      <div data-r={1}>
        <StatusBar ink={C.ink} />
        <div
          style={{
            position: "absolute",
            left: 24,
            right: 24,
            top: 62,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={mono(C.muted, 11)}>Tuesday · Oct 20</span>
          <span
            style={{
              display: "grid",
              placeItems: "center",
              width: 40,
              height: 40,
              borderRadius: 999,
              background: C.terracotta,
              color: C.cream,
              fontFamily: SERIF,
              fontSize: 22,
            }}
          >
            M
          </span>
        </div>
      </div>

      <div data-r={2} style={{ position: "absolute", left: 24, right: 24, top: 110 }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: C.muted }}>Good morning, Maya</div>
        <div
          style={{
            marginTop: 8,
            fontFamily: SERIF,
            fontSize: 50,
            lineHeight: 0.94,
            letterSpacing: "-0.03em",
          }}
        >
          Two plants
          <br />
          are still <span style={{ ...em, color: C.terracotta }}>thirsty.</span>
        </div>
      </div>

      {/* Conditions */}
      <div
        data-r={3}
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 254,
          height: 132,
          borderRadius: 22,
          background: C.forest,
          color: C.cream,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          overflow: "hidden",
        }}
      >
        {[
          { k: "Light", v: "6h", note: "Bright, indirect", fill: 0.75 },
          { k: "Humidity", v: "48%", note: "A little dry", fill: 0.48 },
        ].map((m, i) => (
          <div
            key={m.k}
            style={{
              padding: "18px 20px",
              borderLeft: i ? "1.5px solid rgb(244 239 230 / 0.12)" : "none",
            }}
          >
            <div style={mono("rgb(244 239 230 / 0.55)", 10)}>{m.k}</div>
            <div
              style={{
                marginTop: 6,
                fontFamily: SERIF,
                fontSize: 44,
                lineHeight: 1,
                letterSpacing: "-0.02em",
                color: C.lime,
              }}
            >
              {m.v}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, color: "rgb(244 239 230 / 0.65)" }}>
              {m.note}
            </div>
            <div
              style={{
                marginTop: 10,
                height: 5,
                borderRadius: 999,
                background: "rgb(244 239 230 / 0.14)",
              }}
            >
              <div
                style={{
                  width: `${m.fill * 100}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: C.lime,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Tasks */}
      <div data-r={4} style={{ position: "absolute", left: 24, right: 24, top: 408 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Water today
          </span>
          <span style={mono(C.muted, 10.5)}>1 of 3 done</span>
        </div>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {TASKS.map((t) => (
            <div
              key={t.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: 8,
                paddingRight: 14,
                borderRadius: 22,
                background: CARD,
                boxShadow: HAIR,
              }}
            >
              <Photo
                src={t.src}
                fallback={C.clay}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 15,
                  flexShrink: 0,
                  opacity: t.done ? 0.55 : 1,
                }}
              />
              <div style={{ flex: 1, opacity: t.done ? 0.45 : 1 }}>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 25,
                    lineHeight: 1,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {t.name}
                </div>
                <div style={{ marginTop: 4, fontSize: 13, color: C.muted }}>
                  {t.kind} · {t.amount}
                </div>
              </div>
              <Check done={t.done} />
            </div>
          ))}
        </div>
      </div>

      {/* Streak */}
      <div
        data-r={5}
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 678,
          height: 58,
          padding: "0 10px 0 16px",
          borderRadius: 20,
          background: C.sage,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>12-day streak</div>
          <div style={{ fontSize: 12, color: "rgb(15 26 19 / 0.6)" }}>Since Oct 8</div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {week.map((d, i) => (
            <span
              key={d}
              style={{
                display: "grid",
                placeItems: "center",
                width: 20,
                height: 20,
                borderRadius: 999,
                fontSize: 9.5,
                fontWeight: 700,
                background: i < 1 ? C.forest : i === 1 ? C.lime : "rgb(15 26 19 / 0.08)",
                color: i < 1 ? C.lime : C.ink,
                boxShadow: i === 1 ? `inset 0 0 0 2px ${C.forest}` : "none",
              }}
            >
              {d.charAt(0)}
            </span>
          ))}
        </div>
      </div>

      <TabBar active="today" r={6} />
    </Root>
  );
}

// ---------------------------------------------------------------------------
// App 2. Plant: Juniper, the monstera by the window.

export function AppPlantBoard() {
  const next = 2;
  const every = 7;
  const R = 38;
  const len = 2 * Math.PI * R;
  const care = [
    { k: "Feed", v: "Nov 2", note: "Monthly" },
    { k: "Rotate", v: "Saturday", note: "Weekly" },
    { k: "Repot", v: "April", note: "Yearly" },
  ];
  return (
    <Root width={390} height={844} background={C.cream} color={C.ink}>
      <div data-r={1}>
        <Photo
          src="/demo/hero.webp"
          fallback="radial-gradient(120% 80% at 50% 30%, #2c4a36, #17301f 70%)"
          position="center 30%"
          style={{ position: "absolute", left: 0, top: 0, width: 390, height: 360 }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 130,
            background: "linear-gradient(180deg, rgb(12 26 18 / 0.5), transparent)",
          }}
        />
        <StatusBar ink={C.cream} />
        <div
          style={{
            position: "absolute",
            top: 54,
            left: 16,
            right: 16,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <RoundButton bg="rgb(244 239 230 / 0.88)">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M12.5 4 6.5 10l6 6"
                stroke={C.ink}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </RoundButton>
          <RoundButton bg="rgb(244 239 230 / 0.88)">
            <span style={{ display: "flex", gap: 3 }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{ width: 4, height: 4, borderRadius: 999, background: C.ink }}
                />
              ))}
            </span>
          </RoundButton>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 328,
          bottom: 0,
          background: C.cream,
          borderRadius: "30px 30px 0 0",
        }}
      />

      <div data-r={2} style={{ position: "absolute", left: 24, right: 24, top: 352 }}>
        <div style={{ display: "flex", justifyContent: "space-between", ...mono(C.muted, 10.5) }}>
          <span>Monstera deliciosa</span>
          <span style={{ color: C.forest }}>Living room</span>
        </div>
        <div
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{ fontFamily: SERIF, fontSize: 56, lineHeight: 0.9, letterSpacing: "-0.03em" }}
          >
            Juniper
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 30,
              padding: "0 12px",
              borderRadius: 999,
              background: C.sage,
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 999, background: C.forest }} />
            Thriving
          </span>
        </div>
        <div style={{ marginTop: 8, fontSize: 14, color: C.muted }}>
          With you since March 2024 · 3 new leaves this fall
        </div>
      </div>

      {/* Next watering */}
      <div
        data-r={3}
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 490,
          height: 116,
          padding: "0 16px 0 14px",
          borderRadius: 22,
          background: C.forest,
          color: C.cream,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div style={{ position: "relative", width: 92, height: 92, flexShrink: 0 }}>
          <svg
            width="92"
            height="92"
            viewBox="0 0 92 92"
            aria-hidden="true"
            style={{ display: "block" }}
          >
            <circle
              cx="46"
              cy="46"
              r={R}
              fill="none"
              stroke="rgb(244 239 230 / 0.14)"
              strokeWidth="9"
            />
            <circle
              cx="46"
              cy="46"
              r={R}
              fill="none"
              stroke={C.lime}
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={`${(len * (every - next)) / every} ${len}`}
              transform="rotate(-90 46 46)"
            />
          </svg>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              textAlign: "center",
            }}
          >
            <div>
              <div style={{ fontFamily: SERIF, fontSize: 36, lineHeight: 0.9 }}>{next}</div>
              <div style={{ ...mono("rgb(244 239 230 / 0.6)", 8.5), marginTop: 2 }}>days</div>
            </div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={mono("rgb(244 239 230 / 0.55)", 10)}>Next watering</div>
          <div style={{ marginTop: 4, fontFamily: SERIF, fontSize: 30, lineHeight: 1 }}>
            Thursday
          </div>
          <div style={{ marginTop: 4, fontSize: 13, color: "rgb(244 239 230 / 0.65)" }}>
            500 ml · every {every} days
          </div>
        </div>
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 44,
            height: 44,
            borderRadius: 999,
            background: C.lime,
            flexShrink: 0,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 3.5c3.6 4.3 6 7.5 6 10.6a6 6 0 0 1-12 0c0-3.1 2.4-6.3 6-10.6Z"
              fill={C.forest}
            />
          </svg>
        </span>
      </div>

      {/* Schedule, in ProductBoard's sage care tiles */}
      <div
        data-r={4}
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 618,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 8,
        }}
      >
        {care.map((c) => (
          <div
            key={c.k}
            style={{ background: C.sage, borderRadius: 16, padding: "11px 12px 12px" }}
          >
            <div style={mono("rgb(15 26 19 / 0.6)", 9.5)}>{c.k}</div>
            <div style={{ marginTop: 4, fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>
              {c.v}
            </div>
            <div style={{ fontSize: 12, color: "rgb(15 26 19 / 0.6)" }}>{c.note}</div>
          </div>
        ))}
      </div>

      {/* Latest note */}
      <div
        data-r={5}
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 704,
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}
      >
        <span
          style={{ width: 3, alignSelf: "stretch", borderRadius: 999, background: C.terracotta }}
        />
        <div style={{ fontSize: 13.5, lineHeight: 1.4 }}>
          <span style={{ ...mono(C.terracotta, 10), marginRight: 8 }}>Oct 12</span>A new leaf is
          unfurling on the left stem. Moved her two feet from the window.
        </div>
      </div>

      <TabBar active="plants" r={6} />
    </Root>
  );
}

// ---------------------------------------------------------------------------
// App 3. Shop: the Autumn Drop up top, the nursery below.

const PRODUCTS = [
  { name: "Pilea", note: "Sunny sill", price: "$34", src: "/demo/pilea.webp", tag: "New" },
  { name: "Snake plant", note: "Any corner", price: "$48", src: "/demo/snake.webp", tag: "" },
  { name: "Monstera", note: "Bright shade", price: "$68", src: "/demo/monstera.webp", tag: "" },
  { name: "Pilea, large", note: "Sunny sill", price: "$58", src: "/demo/pilea.webp", tag: "" },
];

export function AppShopBoard() {
  const chips = ["All", "Low light", "Pet-safe", "Large", "Pots"];
  return (
    <Root width={390} height={844} background={C.cream} color={C.ink}>
      <div data-r={1}>
        <StatusBar ink={C.ink} />
        <div
          style={{
            position: "absolute",
            left: 24,
            right: 16,
            top: 58,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{ fontFamily: SERIF, fontSize: 46, lineHeight: 1, letterSpacing: "-0.03em" }}
          >
            Shop
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <RoundButton bg={CARD}>
              <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="9" cy="9" r="5.5" stroke={C.ink} strokeWidth="1.9" />
                <path
                  d="m13.2 13.2 3.6 3.6"
                  stroke={C.ink}
                  strokeWidth="1.9"
                  strokeLinecap="round"
                />
              </svg>
            </RoundButton>
            <span style={{ position: "relative" }}>
              <RoundButton bg={C.forest}>
                <Bag color={C.cream} />
              </RoundButton>
              <span
                style={{
                  position: "absolute",
                  right: -2,
                  top: -2,
                  display: "grid",
                  placeItems: "center",
                  width: 19,
                  height: 19,
                  borderRadius: 999,
                  background: C.lime,
                  fontSize: 11,
                  fontWeight: 700,
                  boxShadow: `0 0 0 2px ${C.cream}`,
                }}
              >
                2
              </span>
            </span>
          </span>
        </div>
      </div>

      {/* The Autumn Drop */}
      <div
        data-r={2}
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          top: 124,
          height: 262,
          borderRadius: 26,
          background: C.terracotta,
          color: C.cream,
          overflow: "hidden",
        }}
      >
        <Photo
          src="/demo/pilea.webp"
          fallback={C.clay}
          position="center 40%"
          style={{
            position: "absolute",
            right: -54,
            top: 26,
            width: 236,
            height: 236,
            borderRadius: 999,
            boxShadow: "0 0 0 10px rgb(244 239 230 / 0.12)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 22,
            top: 22,
            ...mono("rgb(244 239 230 / 0.8)", 10.5),
          }}
        >
          12 new arrivals · Oct 24
        </div>
        <div
          style={{
            position: "absolute",
            left: 22,
            top: 48,
            fontFamily: SERIF,
            fontSize: 52,
            lineHeight: 0.9,
            letterSpacing: "-0.03em",
          }}
        >
          The
          <br />
          <span style={em}>Autumn</span>
          <br />
          Drop
        </div>
        <div
          style={{
            position: "absolute",
            right: 18,
            top: 18,
            width: 74,
            height: 74,
            borderRadius: 999,
            background: C.lime,
            color: C.ink,
            display: "grid",
            placeItems: "center",
            textAlign: "center",
            transform: "rotate(10deg)",
          }}
        >
          <div>
            <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 22, lineHeight: 0.9 }}>
              in
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.03em" }}>4 days</div>
          </div>
        </div>
        <span
          style={{
            position: "absolute",
            left: 22,
            bottom: 18,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 38,
            padding: "0 8px 0 16px",
            borderRadius: 999,
            background: C.cream,
            color: C.ink,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Get notified
          <span
            style={{
              display: "grid",
              placeItems: "center",
              width: 26,
              height: 26,
              borderRadius: 999,
              background: C.terracotta,
            }}
          >
            <Arrow color={C.cream} size={14} />
          </span>
        </span>
      </div>

      {/* Filters */}
      <div
        data-r={3}
        style={{
          position: "absolute",
          left: 16,
          top: 402,
          display: "flex",
          gap: 8,
          whiteSpace: "nowrap",
        }}
      >
        {chips.map((c, i) => (
          <span
            key={c}
            style={{
              display: "flex",
              alignItems: "center",
              height: 38,
              padding: "0 16px",
              borderRadius: 999,
              fontSize: 14,
              fontWeight: 600,
              background: i === 0 ? C.forest : "transparent",
              color: i === 0 ? C.cream : C.ink,
              boxShadow: i === 0 ? "none" : "inset 0 0 0 1.5px rgb(15 26 19 / 0.14)",
            }}
          >
            {c}
          </span>
        ))}
      </div>

      {/* Nursery grid */}
      <div
        data-r={4}
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          top: 456,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
        }}
      >
        {PRODUCTS.map((p) => (
          <div
            key={p.name}
            style={{ borderRadius: 22, background: CARD, boxShadow: HAIR, padding: 6 }}
          >
            <div style={{ position: "relative" }}>
              <Photo
                src={p.src}
                fallback={C.clay}
                position="center 45%"
                style={{ width: "100%", height: 150, borderRadius: 17 }}
              />
              {p.tag && (
                <span
                  style={{
                    position: "absolute",
                    left: 8,
                    top: 8,
                    height: 22,
                    padding: "0 9px",
                    display: "flex",
                    alignItems: "center",
                    borderRadius: 999,
                    background: C.terracotta,
                    color: C.cream,
                    ...mono(C.cream, 9.5),
                  }}
                >
                  {p.tag}
                </span>
              )}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 6px 6px 8px",
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 22,
                    lineHeight: 1,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {p.name}
                </div>
                <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 12, color: C.muted }}>
                  {p.price}
                </div>
              </div>
              <span
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  background: C.lime,
                  fontSize: 20,
                  fontWeight: 500,
                  lineHeight: 1,
                }}
              >
                +
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* fade the grid under the tab bar */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 140,
          background: `linear-gradient(180deg, rgb(244 239 230 / 0), ${C.cream} 70%)`,
        }}
      />

      <TabBar active="shop" r={5} />
    </Root>
  );
}

// ---------------------------------------------------------------------------

export const BRAND_APP_BOARDS: {
  id: string;
  name: string;
  width: number;
  height: number;
  steps: number;
  Component: ComponentType;
}[] = [
  { id: "logo", name: "Logo", width: 1200, height: 800, steps: 6, Component: LogoBoard },
  {
    id: "palette",
    name: "Color & Type",
    width: 1200,
    height: 800,
    steps: 6,
    Component: PaletteBoard,
  },
  { id: "app-today", name: "Today", width: 390, height: 844, steps: 6, Component: AppTodayBoard },
  { id: "app-plant", name: "Plant", width: 390, height: 844, steps: 6, Component: AppPlantBoard },
  { id: "app-shop", name: "Shop", width: 390, height: 844, steps: 5, Component: AppShopBoard },
];
