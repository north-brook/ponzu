import type { ComponentType, CSSProperties, ReactNode } from "react";

// Fernwood: the fictional houseplant shop Claude designs in the product demo.
// Every board is a fixed-size, purely presentational artboard. `data-r` marks
// the order Claude "writes" each piece; the demo engine reveals them in turn.

export const SERIF = "var(--font-instrument-serif), Georgia, serif";
export const SANS = "var(--font-inter), system-ui, sans-serif";
export const MONO = "var(--font-jetbrains-mono), ui-monospace, monospace";

export const C = {
  forest: "#12241a",
  forestDeep: "#0c1a12",
  lime: "#c9f27a",
  cream: "#f4efe6",
  sage: "#c8d5c0",
  ink: "#0f1a13",
  muted: "#6b7a6f",
  terracotta: "#c2603a",
  clay: "#e7d5c0",
};

const NAV = ["Shop", "Journal", "Visit"];

// ---------------------------------------------------------------------------
// Shared pieces

export function Photo({
  src,
  fallback,
  style,
  position = "center",
}: {
  src: string;
  fallback: string;
  style?: CSSProperties;
  position?: string;
}) {
  return (
    <div style={{ overflow: "hidden", background: fallback, ...style }}>
      {/* biome-ignore lint/performance/noImgElement: decorative demo artwork rendered inside a scaled artboard */}
      <img
        src={src}
        alt=""
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: position,
        }}
      />
    </div>
  );
}

export function Frond({ color, size = 26 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M16 30V5" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
      {[8, 13, 18, 23].map((y, i) => {
        const w = 11 - i * 1.6;
        return (
          <g key={y} fill={color}>
            <ellipse
              cx={16 - w / 2}
              cy={y}
              rx={w / 2}
              ry="2.1"
              transform={`rotate(-28 ${16 - w / 2} ${y})`}
            />
            <ellipse
              cx={16 + w / 2}
              cy={y}
              rx={w / 2}
              ry="2.1"
              transform={`rotate(28 ${16 + w / 2} ${y})`}
            />
          </g>
        );
      })}
      <ellipse cx="16" cy="4" rx="2" ry="3" fill={color} />
    </svg>
  );
}

function Logo({ color, mark, size = 32 }: { color: string; mark: string; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, color }}>
      <Frond color={mark} size={size * 0.9} />
      <span style={{ fontFamily: SERIF, fontSize: size, lineHeight: 1, letterSpacing: "-0.01em" }}>
        Fernwood
      </span>
    </div>
  );
}

export function Bag({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 7h12l-1 10.5H5L4 7Z" stroke={color} strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M7.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke={color} strokeWidth="1.7" />
    </svg>
  );
}

export function Arrow({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4 10h12m-5-5 5 5-5 5"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Nav({
  color,
  mark,
  cartBg,
  cartInk,
  badgeBg,
  badgeInk,
  style,
  r = 1,
}: {
  color: string;
  mark: string;
  cartBg: string;
  cartInk: string;
  badgeBg: string;
  badgeInk: string;
  style?: CSSProperties;
  r?: number;
}) {
  return (
    <div
      data-r={r}
      style={{
        position: "absolute",
        top: 0,
        left: 64,
        right: 64,
        height: 104,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        ...style,
      }}
    >
      <Logo color={color} mark={mark} />
      <div style={{ display: "flex", alignItems: "center", gap: 44 }}>
        {NAV.map((item) => (
          <span
            key={item}
            style={{ fontSize: 16, fontWeight: 500, color, letterSpacing: "-0.005em" }}
          >
            {item}
          </span>
        ))}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            height: 44,
            padding: "0 8px 0 18px",
            borderRadius: 999,
            background: cartBg,
            color: cartInk,
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          <Bag color={cartInk} />
          Cart
          <span
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 999,
              background: badgeBg,
              color: badgeInk,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            2
          </span>
        </span>
      </div>
    </div>
  );
}

export function Root({
  width = 1440,
  height = 900,
  background,
  color,
  children,
}: {
  width?: number;
  height?: number;
  background: string;
  color: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        overflow: "hidden",
        background,
        color,
        fontFamily: SANS,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {children}
    </div>
  );
}

const em: CSSProperties = { fontStyle: "italic", letterSpacing: "-0.02em" };

// ---------------------------------------------------------------------------
// 1. Home / Hero: forest, lime, a nursery tag and a pot you'll keep.

const NURSERY = [
  { name: "Monstera", note: "Bright, indirect", price: "$68", src: "/demo/monstera.webp" },
  { name: "Pilea", note: "Sunny sill", price: "$34", src: "/demo/pilea.webp" },
  { name: "Snake plant", note: "Any corner", price: "$48", src: "/demo/snake.webp" },
];

export function HomeBoard() {
  return (
    <Root background={C.forest} color={C.cream}>
      <Nav
        color={C.cream}
        mark={C.lime}
        cartBg="rgb(244 239 230 / 0.08)"
        cartInk={C.cream}
        badgeBg={C.lime}
        badgeInk={C.ink}
      />

      <h1
        data-r={2}
        data-anchor="headline"
        style={{
          position: "absolute",
          left: 60,
          top: 150,
          margin: 0,
          fontFamily: SERIF,
          fontWeight: 400,
          fontSize: 150,
          lineHeight: 0.88,
          letterSpacing: "-0.035em",
          color: C.cream,
        }}
      >
        Plants that
        <br />
        <span style={{ ...em, color: C.lime }}>outlive</span>
        <br />
        your lease.
      </h1>

      <p
        data-r={3}
        style={{
          position: "absolute",
          left: 64,
          top: 578,
          width: 440,
          margin: 0,
          fontSize: 19,
          lineHeight: 1.5,
          color: "rgb(244 239 230 / 0.72)",
        }}
      >
        Hardy, beautiful houseplants delivered in pots you'll keep, with care guides written by
        people who actually water things.
      </p>

      <div
        data-r={4}
        style={{
          position: "absolute",
          left: 64,
          top: 682,
          display: "flex",
          alignItems: "center",
          gap: 28,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            height: 60,
            padding: "0 10px 0 30px",
            borderRadius: 999,
            background: C.lime,
            color: C.ink,
            fontSize: 17,
            fontWeight: 600,
          }}
        >
          Shop the nursery
          <span
            style={{
              display: "grid",
              placeItems: "center",
              width: 42,
              height: 42,
              borderRadius: 999,
              background: C.forest,
            }}
          >
            <Arrow color={C.lime} />
          </span>
        </span>
        <span
          style={{
            fontSize: 17,
            fontWeight: 500,
            paddingBottom: 3,
            borderBottom: "1.5px solid rgb(244 239 230 / 0.4)",
          }}
        >
          Read the care guides
        </span>
      </div>

      <div
        data-r={5}
        style={{ position: "absolute", left: 820, top: 104, width: 572, height: 715 }}
      >
        <Photo
          src="/demo/hero.webp"
          fallback="radial-gradient(120% 80% at 50% 30%, #2c4a36, #17301f 70%)"
          style={{ width: "100%", height: "100%", borderRadius: 28 }}
        />
      </div>

      {/* Nursery tag, staked into the photo's corner */}
      <div data-r={6} style={{ position: "absolute", left: 706, top: 560, width: 300 }}>
        <div
          style={{
            transform: "rotate(-5deg)",
            transformOrigin: "20% 50%",
            background: C.cream,
            color: C.ink,
            borderRadius: 18,
            padding: "26px 28px 24px 28px",
            boxShadow: "0 30px 60px -20px rgb(0 0 0 / 0.55), 0 2px 0 rgb(0 0 0 / 0.04)",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 18,
              right: 22,
              width: 16,
              height: 16,
              borderRadius: 999,
              background: C.forest,
              boxShadow: "inset 0 2px 3px rgb(0 0 0 / 0.5)",
            }}
          />
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: C.muted,
            }}
          >
            Araceae · Easy
          </div>
          <div style={{ fontFamily: SERIF, fontSize: 34, lineHeight: 1, marginTop: 10 }}>
            Monstera
            <br />
            <span style={{ fontStyle: "italic" }}>deliciosa</span>
          </div>
          <div
            style={{
              marginTop: 16,
              paddingTop: 14,
              borderTop: "1px dashed rgb(15 26 19 / 0.25)",
              display: "grid",
              gridTemplateColumns: "64px 1fr",
              rowGap: 6,
              fontFamily: MONO,
              fontSize: 11.5,
              lineHeight: 1.4,
            }}
          >
            <span style={{ color: C.muted }}>LIGHT</span>
            <span>Bright, indirect</span>
            <span style={{ color: C.muted }}>WATER</span>
            <span>Every 7–10 days</span>
          </div>
          <div
            style={{
              marginTop: 16,
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 1 }}>$68</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: C.muted }}>10″ pot included</span>
          </div>
        </div>
      </div>

      {/* Lime seal over the photo's top edge */}
      <div
        data-r={7}
        style={{ position: "absolute", left: 1222, top: 128, width: 156, height: 156 }}
      >
        <svg
          width="156"
          height="156"
          viewBox="0 0 156 156"
          aria-hidden="true"
          style={{ display: "block", transform: "rotate(-14deg)" }}
        >
          <defs>
            <path id="fw-seal" d="M78 78m-56 0a56 56 0 1 1 112 0a56 56 0 1 1 -112 0" />
          </defs>
          <circle cx="78" cy="78" r="76" fill={C.lime} />
          <text
            fill={C.ink}
            style={{
              fontFamily: SANS,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
            }}
          >
            <textPath href="#fw-seal">Pots you'll keep · Care guide inside ·</textPath>
          </text>
          <g transform="translate(58 56) scale(1.25)">
            <Frond color={C.forest} size={32} />
          </g>
        </svg>
      </div>

      <div
        data-r={8}
        style={{
          position: "absolute",
          left: 64,
          top: 800,
          width: 640,
          display: "flex",
          alignItems: "center",
          gap: 34,
          paddingTop: 22,
          borderTop: "1px solid rgb(244 239 230 / 0.14)",
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            lineHeight: 1.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "rgb(244 239 230 / 0.5)",
            width: 92,
          }}
        >
          In the nursery
        </span>
        {NURSERY.map((p) => (
          <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Photo
              src={p.src}
              fallback={C.clay}
              style={{ width: 44, height: 44, borderRadius: 999 }}
            />
            <div style={{ lineHeight: 1.25 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{p.name}</div>
              <div style={{ fontSize: 13, color: "rgb(244 239 230 / 0.55)" }}>{p.price}</div>
            </div>
          </div>
        ))}
      </div>
    </Root>
  );
}

// ---------------------------------------------------------------------------
// 2. Mobile / Product

function CareIcon({ kind }: { kind: "light" | "water" | "pet" }) {
  const s = { stroke: C.forest, strokeWidth: 1.8, fill: "none", strokeLinecap: "round" } as const;
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      {kind === "light" && (
        <>
          <circle cx="12" cy="12" r="4.2" {...s} />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <path key={a} d="M12 2.8v2.4" {...s} transform={`rotate(${a} 12 12)`} />
          ))}
        </>
      )}
      {kind === "water" && (
        <path d="M12 3.5c3.6 4.3 6 7.5 6 10.6a6 6 0 0 1-12 0c0-3.1 2.4-6.3 6-10.6Z" {...s} />
      )}
      {kind === "pet" && (
        <>
          <circle cx="12" cy="15" r="3.6" {...s} />
          <circle cx="6.4" cy="10" r="1.8" {...s} />
          <circle cx="17.6" cy="10" r="1.8" {...s} />
          <circle cx="9.4" cy="6" r="1.8" {...s} />
          <circle cx="14.6" cy="6" r="1.8" {...s} />
        </>
      )}
    </svg>
  );
}

export function ProductBoard() {
  const care = [
    { kind: "light" as const, label: "Light", value: "Bright shade" },
    { kind: "water" as const, label: "Water", value: "Every 10 days" },
    { kind: "pet" as const, label: "Pets", value: "Not pet-safe" },
  ];
  return (
    <Root width={390} height={844} background={C.cream} color={C.ink}>
      <div data-r={2}>
        <Photo
          src="/demo/monstera.webp"
          fallback="radial-gradient(90% 70% at 50% 45%, #efe6d6, #e2d4bf)"
          style={{ position: "absolute", left: 0, top: 0, width: 390, height: 400 }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            justifyContent: "center",
            top: 334,
            display: "flex",
            gap: 6,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              style={{
                width: i === 0 ? 22 : 7,
                height: 7,
                borderRadius: 999,
                background: i === 0 ? C.forest : "rgb(18 36 26 / 0.25)",
              }}
            />
          ))}
        </div>
      </div>

      <div data-r={1}>
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
          }}
        >
          <span>9:41</span>
          <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <span
              style={{ width: 17, height: 11, borderRadius: 2, background: C.ink, opacity: 0.85 }}
            />
            <span
              style={{
                width: 25,
                height: 12,
                borderRadius: 4,
                border: `1.5px solid ${C.ink}`,
                padding: 1.5,
                opacity: 0.85,
              }}
            >
              <span
                style={{
                  display: "block",
                  width: "75%",
                  height: "100%",
                  borderRadius: 2,
                  background: C.ink,
                }}
              />
            </span>
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            top: 54,
            left: 16,
            right: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {[
            <svg key="b" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M12.5 4 6.5 10l6 6"
                stroke={C.ink}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>,
            <Bag key="c" color={C.ink} />,
          ].map((icon, i) => (
            <span
              key={i === 0 ? "back" : "cart"}
              style={{
                display: "grid",
                placeItems: "center",
                width: 44,
                height: 44,
                borderRadius: 999,
                background: "rgb(244 239 230 / 0.85)",
                boxShadow: "0 1px 2px rgb(15 26 19 / 0.08)",
              }}
            >
              {icon}
            </span>
          ))}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 362,
          bottom: 0,
          background: C.cream,
          borderRadius: "30px 30px 0 0",
        }}
      />

      <div data-r={3} style={{ position: "absolute", left: 24, right: 24, top: 388 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: MONO,
            fontSize: 10.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.muted,
          }}
        >
          <span>Araceae · Easy care</span>
          <span style={{ color: C.forest }}>★ 4.9 (212)</span>
        </div>
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 0.92, letterSpacing: "-0.02em" }}
          >
            Monstera
            <br />
            <span style={{ fontStyle: "italic" }}>deliciosa</span>
          </div>
          <div style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 0.92 }}>$68</div>
        </div>
        <p style={{ margin: "12px 0 0", fontSize: 14, lineHeight: 1.5, color: C.muted }}>
          Grows a new split leaf about once a month and forgives the odd missed watering.
        </p>
      </div>

      <div data-r={4} style={{ position: "absolute", left: 24, right: 24, top: 572 }}>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { size: '6"', price: "$38" },
            { size: '10"', price: "$68" },
            { size: '14"', price: "$124" },
          ].map((o) => {
            const on = o.size === '10"';
            return (
              <span
                key={o.size}
                style={{
                  flex: 1,
                  height: 46,
                  borderRadius: 999,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  fontSize: 14,
                  fontWeight: 600,
                  background: on ? C.forest : "transparent",
                  color: on ? C.cream : C.ink,
                  boxShadow: on ? "none" : "inset 0 0 0 1.5px rgb(15 26 19 / 0.14)",
                }}
              >
                {o.size}
                <span style={{ fontWeight: 400, opacity: 0.6 }}>{o.price}</span>
              </span>
            );
          })}
        </div>
      </div>

      <div
        data-r={5}
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 634,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 8,
        }}
      >
        {care.map((c) => (
          <div
            key={c.label}
            style={{ background: C.sage, borderRadius: 16, padding: "12px 12px 13px" }}
          >
            <CareIcon kind={c.kind} />
            <div
              style={{
                marginTop: 8,
                fontFamily: MONO,
                fontSize: 9.5,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "rgb(15 26 19 / 0.6)",
              }}
            >
              {c.label}
            </div>
            <div style={{ marginTop: 2, fontSize: 12.5, fontWeight: 600, lineHeight: 1.25 }}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <div
        data-r={6}
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: 26,
          display: "flex",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: 104,
            height: 58,
            padding: "0 18px",
            borderRadius: 999,
            boxShadow: "inset 0 0 0 1.5px rgb(15 26 19 / 0.14)",
            fontSize: 18,
            fontWeight: 500,
          }}
        >
          <span style={{ color: C.muted }}>−</span>1<span style={{ color: C.muted }}>+</span>
        </span>
        <span
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            height: 58,
            padding: "0 8px 0 24px",
            borderRadius: 999,
            background: C.forest,
            color: C.cream,
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          Add to cart
          <span
            style={{
              display: "grid",
              placeItems: "center",
              height: 42,
              padding: "0 16px",
              borderRadius: 999,
              background: C.lime,
              color: C.ink,
              fontSize: 15,
            }}
          >
            $68
          </span>
        </span>
      </div>
    </Root>
  );
}

// ---------------------------------------------------------------------------
// 3. Hero / Night Garden: the shop after hours, lit by one warm lamp.

const AMBER = "#f2b766";

export function NightBoard() {
  const late = [
    { name: "Snake plant", note: "Thrives in low light", price: "$48", src: "/demo/snake.webp" },
    { name: "Pilea", note: "Lamp-side favourite", price: "$34", src: "/demo/pilea.webp" },
    { name: "Monstera", note: "Big leaves, slow nights", price: "$68", src: "/demo/monstera.webp" },
  ];
  return (
    <Root background="#060c08" color={C.cream}>
      <Photo
        src="/demo/night.webp"
        fallback="radial-gradient(50% 55% at 62% 42%, #6b4a22 0%, #24301c 40%, #0a140d 75%)"
        style={{ position: "absolute", inset: 0 }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(70% 60% at 50% 48%, rgb(6 12 8 / 0.15), rgb(6 12 8 / 0.7) 80%), linear-gradient(180deg, rgb(6 12 8 / 0.55) 0%, rgb(6 12 8 / 0) 22%, rgb(6 12 8 / 0) 55%, rgb(6 12 8 / 0.92) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 420,
          top: 180,
          width: 600,
          height: 420,
          borderRadius: 999,
          background: "radial-gradient(closest-side, rgb(242 183 102 / 0.22), transparent)",
          filter: "blur(10px)",
        }}
      />

      <Nav
        color={C.cream}
        mark={AMBER}
        cartBg="rgb(244 239 230 / 0.1)"
        cartInk={C.cream}
        badgeBg={AMBER}
        badgeInk={C.ink}
      />

      <div
        data-r={2}
        style={{ position: "absolute", left: 0, right: 0, top: 184, textAlign: "center" }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            fontFamily: MONO,
            fontSize: 12,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgb(244 239 230 / 0.75)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: AMBER,
              boxShadow: `0 0 12px 3px ${AMBER}`,
            }}
          />
          Open late Thursdays · 6–10pm
        </div>
        <h1
          data-anchor="headline"
          style={{
            margin: "26px 0 0",
            fontFamily: SERIF,
            fontWeight: 400,
            fontSize: 164,
            lineHeight: 0.88,
            letterSpacing: "-0.035em",
            textShadow: "0 0 60px rgb(242 183 102 / 0.35)",
          }}
        >
          Plants that outlive
          <br />
          your <span style={{ ...em, color: AMBER }}>lease.</span>
        </h1>
      </div>

      <div
        data-r={3}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 580,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 28,
        }}
      >
        <p
          style={{
            margin: 0,
            width: 520,
            textAlign: "center",
            fontSize: 19,
            lineHeight: 1.5,
            color: "rgb(244 239 230 / 0.72)",
          }}
        >
          Hardy, beautiful houseplants in pots you'll keep, with care guides written by people who
          actually water things.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              height: 58,
              padding: "0 28px",
              borderRadius: 999,
              background: C.cream,
              color: C.ink,
              fontSize: 17,
              fontWeight: 600,
              boxShadow: "0 0 40px rgb(242 183 102 / 0.35)",
            }}
          >
            Shop low-light plants
            <Arrow color={C.ink} />
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              height: 58,
              padding: "0 28px",
              borderRadius: 999,
              boxShadow: "inset 0 0 0 1.5px rgb(244 239 230 / 0.35)",
              fontSize: 17,
              fontWeight: 500,
            }}
          >
            Plan a visit
          </span>
        </div>
      </div>

      <div
        data-r={4}
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          bottom: 44,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 16,
        }}
      >
        {late.map((p) => (
          <div
            key={p.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: 12,
              borderRadius: 22,
              background: "rgb(244 239 230 / 0.07)",
              boxShadow: "inset 0 0 0 1px rgb(244 239 230 / 0.12)",
              backdropFilter: "blur(14px)",
            }}
          >
            <Photo
              src={p.src}
              fallback="#2a2a1e"
              style={{ width: 64, height: 64, borderRadius: 14 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: SERIF, fontSize: 26, lineHeight: 1 }}>{p.name}</div>
              <div style={{ marginTop: 5, fontSize: 13.5, color: "rgb(244 239 230 / 0.6)" }}>
                {p.note}
              </div>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 14, color: AMBER, paddingRight: 10 }}>
              {p.price}
            </div>
          </div>
        ))}
      </div>
    </Root>
  );
}

// ---------------------------------------------------------------------------
// 4. Hero / Sunroom: an arched window full of late light.

const SUN = {
  bg: "#f6ecdd",
  sash: "#fbf6ee",
  clay: "#c2603a",
  gold: "#e9b45c",
  ink: "#1d2a1f",
  soft: "#7a6a58",
};

export function SunroomBoard({ revised = false }: { revised?: boolean }) {
  return (
    <Root background={SUN.bg} color={SUN.ink}>
      {/* late-afternoon light falling across the room */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(60% 70% at 78% 10%, rgb(255 214 150 / 0.65), transparent 70%), radial-gradient(50% 50% at 10% 100%, rgb(194 96 58 / 0.12), transparent 70%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -200,
          top: -100,
          width: 1100,
          height: 1200,
          transform: "rotate(-28deg)",
          background:
            "repeating-linear-gradient(90deg, transparent 0 120px, rgb(255 236 200 / 0.4) 120px 200px, transparent 200px 300px)",
          filter: "blur(18px)",
          opacity: 0.8,
        }}
      />

      <Nav
        color={SUN.ink}
        mark={SUN.clay}
        cartBg={SUN.ink}
        cartInk={SUN.sash}
        badgeBg={SUN.gold}
        badgeInk={SUN.ink}
      />

      {revised && (
        <div
          data-revision
          style={{
            position: "absolute",
            left: 64,
            top: 138,
            display: "flex",
            alignItems: "center",
            gap: 16,
            height: 72,
            padding: "0 12px 0 10px",
            borderRadius: 999,
            background: SUN.sash,
            boxShadow:
              "0 12px 30px -14px rgb(122 70 30 / 0.4), inset 0 0 0 1px rgb(194 96 58 / 0.18)",
          }}
        >
          <Photo
            src="/demo/pilea.webp"
            fallback={C.clay}
            style={{ width: 52, height: 52, borderRadius: 999 }}
          />
          <div style={{ lineHeight: 1.15 }}>
            <div style={{ fontFamily: SERIF, fontSize: 27 }}>
              The <span style={{ fontStyle: "italic", color: SUN.clay }}>Autumn</span> Drop
            </div>
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: SUN.soft,
                marginTop: 2,
              }}
            >
              12 new arrivals · Oct 24
            </div>
          </div>
          <span
            style={{
              marginLeft: 18,
              display: "grid",
              placeItems: "center",
              width: 48,
              height: 48,
              borderRadius: 999,
              background: SUN.clay,
            }}
          >
            <Arrow color={SUN.sash} />
          </span>
        </div>
      )}

      <h1
        data-r={2}
        data-anchor="headline"
        style={{
          position: "absolute",
          left: 60,
          top: 236,
          margin: 0,
          fontFamily: SERIF,
          fontWeight: 400,
          fontSize: 138,
          lineHeight: 0.9,
          letterSpacing: "-0.035em",
        }}
      >
        Plants that
        <br />
        <span style={{ ...em, color: SUN.clay }}>outlive</span> your
        <br />
        lease.
      </h1>

      <div data-r={3} style={{ position: "absolute", left: 64, top: 638, width: 520 }}>
        <p style={{ margin: 0, fontSize: 19, lineHeight: 1.5, color: SUN.soft, width: 460 }}>
          Hardy, beautiful houseplants delivered in pots you'll keep, with care guides written by
          people who actually water things.
        </p>
        <div style={{ marginTop: 32, display: "flex", alignItems: "center", gap: 26 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              height: 60,
              padding: "0 30px",
              borderRadius: 999,
              background: SUN.clay,
              color: SUN.sash,
              fontSize: 17,
              fontWeight: 600,
              boxShadow: "0 14px 30px -12px rgb(194 96 58 / 0.6)",
            }}
          >
            Shop the nursery
            <Arrow color={SUN.sash} />
          </span>
          <span
            style={{
              fontSize: 17,
              fontWeight: 500,
              borderBottom: `1.5px solid ${SUN.ink}`,
              paddingBottom: 3,
            }}
          >
            Find plants for your light
          </span>
        </div>
      </div>

      {/* Arched sunroom window */}
      <div
        data-r={4}
        style={{ position: "absolute", left: 760, top: 112, width: 616, height: 740 }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "308px 308px 24px 24px",
            overflow: "hidden",
            background: SUN.sash,
            padding: 14,
            boxShadow: "0 40px 80px -40px rgb(122 70 30 / 0.45)",
          }}
        >
          <Photo
            src="/demo/sunroom.webp"
            fallback="radial-gradient(80% 60% at 60% 20%, #fff1cf, #e8d2a6 50%, #b9c49a 100%)"
            position="center 40%"
            style={{ width: "100%", height: "100%", borderRadius: "294px 294px 12px 12px" }}
          />
          {/* mullions */}
          <span
            style={{
              position: "absolute",
              left: 302,
              top: 0,
              bottom: 0,
              width: 12,
              background: SUN.sash,
            }}
          />
          <span
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 300,
              height: 12,
              background: SUN.sash,
            }}
          />
          <span
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 530,
              height: 12,
              background: SUN.sash,
            }}
          />
        </div>
      </div>

      <div data-r={5} style={{ position: "absolute", left: 640, top: 664 }}>
        <div
          style={{
            transform: "rotate(-3deg)",
            width: 236,
            padding: "20px 22px",
            borderRadius: 20,
            background: SUN.sash,
            boxShadow: "0 24px 50px -20px rgb(122 70 30 / 0.5)",
          }}
        >
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: SUN.soft,
            }}
          >
            South-facing room?
          </div>
          <div style={{ marginTop: 8, fontFamily: SERIF, fontSize: 28, lineHeight: 1.02 }}>
            34 plants that
            <br />
            <span style={{ fontStyle: "italic", color: SUN.clay }}>love the sun</span>
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 6 }}>
            {["N", "E", "S", "W"].map((d) => (
              <span
                key={d}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 600,
                  background: d === "S" ? SUN.gold : "transparent",
                  boxShadow: d === "S" ? "none" : "inset 0 0 0 1.5px rgb(29 42 31 / 0.15)",
                }}
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Root>
  );
}

// ---------------------------------------------------------------------------
// 5. Hero / Market Day: the Saturday plant market as a poster.

export function MarketBoard() {
  const stickers = [
    {
      src: "/demo/monstera.webp",
      price: "$68",
      name: "Monstera",
      left: 1010,
      top: 118,
      size: 300,
      rot: 6,
    },
    {
      src: "/demo/pilea.webp",
      price: "$34",
      name: "Pilea",
      left: 880,
      top: 470,
      size: 230,
      rot: -9,
    },
    {
      src: "/demo/snake.webp",
      price: "$48",
      name: "Snake plant",
      left: 1150,
      top: 470,
      size: 236,
      rot: 5,
    },
  ];
  const ticker =
    "Pots you'll keep ✺ Care guides by people who water things ✺ Free delivery over $75 ✺ Saturday market 9–2 ✺ ";
  return (
    <Root background={C.lime} color={C.forest}>
      <Nav
        color={C.forest}
        mark={C.forest}
        cartBg={C.forest}
        cartInk={C.lime}
        badgeBg={C.lime}
        badgeInk={C.forest}
      />

      <h1
        data-r={2}
        data-anchor="headline"
        style={{ position: "absolute", left: 56, top: 118, margin: 0, fontWeight: 400 }}
      >
        <span
          style={{
            display: "block",
            fontFamily: SANS,
            fontWeight: 700,
            fontSize: 118,
            lineHeight: 0.9,
            letterSpacing: "-0.055em",
            textTransform: "uppercase",
          }}
        >
          Plants that
        </span>
        <span
          style={{
            display: "block",
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: 330,
            lineHeight: 0.78,
            letterSpacing: "-0.05em",
            marginLeft: -10,
            marginTop: 14,
          }}
        >
          outlive
        </span>
        <span
          style={{
            display: "block",
            fontFamily: SANS,
            fontWeight: 700,
            fontSize: 118,
            lineHeight: 0.9,
            letterSpacing: "-0.055em",
            textTransform: "uppercase",
            marginTop: 6,
          }}
        >
          your lease.
        </span>
      </h1>

      <div data-r={3}>
        {stickers.map((s) => (
          <div
            key={s.name}
            style={{ position: "absolute", left: s.left, top: s.top, width: s.size }}
          >
            <div style={{ transform: `rotate(${s.rot}deg)` }}>
              <div
                style={{
                  padding: 10,
                  borderRadius: 30,
                  background: C.cream,
                  boxShadow: "0 22px 40px -18px rgb(18 36 26 / 0.55)",
                }}
              >
                <Photo
                  src={s.src}
                  fallback={C.clay}
                  style={{ width: "100%", aspectRatio: "1", borderRadius: 22 }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    padding: "10px 8px 2px",
                    fontWeight: 700,
                    fontSize: 17,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {s.name}
                  <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 13 }}>{s.price}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
        <div style={{ position: "absolute", left: 1232, top: 82, width: 128, height: 128 }}>
          <div
            style={{
              transform: "rotate(14deg)",
              width: 128,
              height: 128,
              borderRadius: 999,
              background: C.forest,
              color: C.lime,
              display: "grid",
              placeItems: "center",
              textAlign: "center",
            }}
          >
            <div>
              <div
                style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 40, lineHeight: 0.9 }}
              >
                3 for
              </div>
              <div style={{ fontWeight: 700, fontSize: 30, letterSpacing: "-0.04em" }}>$120</div>
            </div>
          </div>
        </div>
      </div>

      <div
        data-r={4}
        style={{
          position: "absolute",
          left: 64,
          top: 690,
          display: "flex",
          alignItems: "center",
          gap: 26,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            height: 62,
            padding: "0 30px",
            borderRadius: 999,
            background: C.forest,
            color: C.lime,
            fontSize: 18,
            fontWeight: 700,
          }}
        >
          Shop the market
          <Arrow color={C.lime} />
        </span>
        <div style={{ fontSize: 15, lineHeight: 1.4, fontWeight: 500 }}>
          <div style={{ fontWeight: 700 }}>Saturday, Oct 26 · 9am–2pm</div>
          <div style={{ opacity: 0.7 }}>214 Wythe Ave, Brooklyn. Bring your old pots.</div>
        </div>
      </div>

      <div
        data-r={5}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 76,
          background: C.forest,
          color: C.lime,
          display: "flex",
          alignItems: "center",
          whiteSpace: "nowrap",
          overflow: "hidden",
          fontWeight: 700,
          fontSize: 24,
          letterSpacing: "-0.01em",
          textTransform: "uppercase",
        }}
      >
        <span style={{ paddingLeft: 24 }}>
          {ticker}
          {ticker}
        </span>
      </div>
    </Root>
  );
}

// ---------------------------------------------------------------------------

export const BOARDS: {
  id: string;
  name: string;
  width: number;
  height: number;
  Component: ComponentType;
}[] = [
  { id: "home", name: "Hero", width: 1440, height: 900, Component: HomeBoard },
  { id: "product", name: "Mobile / Product", width: 390, height: 844, Component: ProductBoard },
  { id: "night", name: "Hero / Night Garden", width: 1440, height: 900, Component: NightBoard },
  { id: "sunroom", name: "Hero / Sunroom", width: 1440, height: 900, Component: SunroomBoard },
  { id: "market", name: "Hero / Market Day", width: 1440, height: 900, Component: MarketBoard },
];
