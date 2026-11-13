/*
 * The parts an email's content is made of: the one action, the digest's link rows, the recap's
 * canvases, the people who joined and the usage bar. Names sit in `dir="auto"` spans, so a
 * right-to-left name reads correctly; decorations carry `data-skip-in-text`, so the text part is
 * only words and links.
 */
import { Button } from "react-email";
import { FONT, LIGHT, SPACE, TYPE } from "../tokens.ts";
import { words } from "../words.ts";
import { Gap, px, TextLink } from "./layout.tsx";

/**
 * The one action an email may have: a verb and an object, left-aligned with the text, never
 * full-bleed, at least 44px to tap, and an optional text link under it.
 */
export function Action({
  href,
  label,
  secondary,
}: {
  href: string;
  label: string;
  secondary?: { href: string; label: string };
}) {
  return (
    <>
      <div style={{ margin: `${SPACE.afterContent - SPACE.afterParagraph}px 0 0` }}>
        <Button
          href={href}
          className="pz-action"
          data-action="true"
          style={{
            backgroundColor: LIGHT.action,
            color: LIGHT.actionInk,
            borderRadius: "8px",
            padding: "13px 20px",
            fontFamily: FONT.body,
            fontWeight: 600,
            ...px(TYPE.action),
          }}
        >
          {label}
        </Button>
      </div>
      {secondary ? (
        <p style={{ margin: "16px 0 0", ...px(TYPE.muted) }}>
          <TextLink href={secondary.href}>{secondary.label}</TextLink>
        </p>
      ) : null}
    </>
  );
}

/** A name as a heading: a digest group's, the recap's canvases'. */
function NameHeading({ children, top }: { children: string; top: number }) {
  return (
    <h2
      className="pz-ink"
      dir="auto"
      style={{
        margin: `${top}px 0 4px`,
        fontFamily: FONT.display,
        fontWeight: 600,
        ...px(TYPE.heading),
        color: LIGHT.ink,
      }}
    >
      {children}
    </h2>
  );
}

const rowBorder = { borderTop: `1px solid ${LIGHT.hairline}` };

/** The digest's groups: a heading each, then full-width link rows separated by hairlines. */
export function LinkRows({
  groups,
}: {
  groups: readonly {
    name: string;
    lines: readonly { text: string; href: string | null }[];
    more: number;
  }[];
}) {
  return (
    <>
      {groups.map((group, g) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rendered once.
        <div key={g}>
          <NameHeading top={g === 0 ? 8 : 24}>{group.name}</NameHeading>
          <table
            role="presentation"
            width="100%"
            cellPadding={0}
            cellSpacing={0}
            style={{ borderCollapse: "collapse" }}
          >
            <tbody>
              {group.lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rendered once.
                <tr key={i}>
                  <td className="pz-hairline" style={i === 0 ? {} : rowBorder}>
                    {line.href ? (
                      <a
                        href={line.href}
                        className="pz-ink"
                        style={{
                          display: "block",
                          padding: "10px 0",
                          color: LIGHT.ink,
                          textDecoration: "none",
                        }}
                      >
                        {line.text}
                        <span
                          className="pz-muted"
                          data-skip-in-text="true"
                          style={{ color: LIGHT.muted }}
                        >
                          {" →"}
                        </span>
                      </a>
                    ) : (
                      <div className="pz-ink" style={{ padding: "10px 0", color: LIGHT.ink }}>
                        {line.text}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {group.more > 0 ? (
                <tr>
                  <td className="pz-hairline" style={rowBorder}>
                    <div
                      className="pz-muted"
                      style={{ padding: "10px 0", ...px(TYPE.muted), color: LIGHT.muted }}
                    >
                      {words.andMore(group.more)}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ))}
      <Gap size={SPACE.afterContent - 10} />
    </>
  );
}

/** The recap's canvases: each name a link, and under it the numbers that merged. */
export function CanvasList({
  canvases,
}: {
  canvases: readonly { name: string; href: string; numbers: string; rest: string }[];
}) {
  return (
    <>
      {canvases.map((canvas, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rendered once.
        <div key={i} style={{ margin: i === 0 ? "8px 0 0" : "20px 0 0" }}>
          <p
            dir="auto"
            style={{
              margin: 0,
              fontFamily: FONT.display,
              fontWeight: 600,
              ...px(TYPE.heading),
            }}
          >
            <a
              href={canvas.href}
              className="pz-ink"
              style={{ color: LIGHT.ink, textDecoration: "underline" }}
            >
              {canvas.name}
            </a>
          </p>
          <p
            className="pz-muted"
            style={{ margin: "2px 0 0", ...px(TYPE.muted), color: LIGHT.muted }}
          >
            <span style={{ fontFamily: FONT.mono, ...px(TYPE.mono) }}>{canvas.numbers}</span>{" "}
            {canvas.rest}
          </p>
        </div>
      ))}
      <Gap />
    </>
  );
}

/** The people who joined: their name in ink and `@login` after it in muted mono. */
export function PeopleList({
  people,
  more,
}: {
  people: readonly { name: string | null; login: string }[];
  more: number;
}) {
  return (
    <>
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        style={{ borderCollapse: "collapse", margin: "4px 0 0" }}
      >
        <tbody>
          {people.map((person, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rendered once.
            <tr key={i}>
              <td
                className="pz-hairline"
                style={{ padding: "8px 0", ...(i === 0 ? {} : rowBorder) }}
              >
                {person.name ? (
                  <>
                    <span className="pz-ink" dir="auto" style={{ color: LIGHT.ink }}>
                      {person.name}
                    </span>{" "}
                  </>
                ) : null}
                <span
                  className={person.name ? "pz-muted" : "pz-ink"}
                  style={{
                    fontFamily: FONT.mono,
                    ...px(TYPE.mono),
                    color: person.name ? LIGHT.muted : LIGHT.ink,
                  }}
                >
                  {`@${person.login}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 ? (
        <p
          className="pz-muted"
          style={{ margin: "8px 0 0", ...px(TYPE.muted), color: LIGHT.muted }}
        >
          {words.andMore(more)}
        </p>
      ) : null}
      <Gap size={SPACE.afterContent - SPACE.afterParagraph} />
    </>
  );
}

/**
 * How much of the cap is used, as a bar: ink on a hairline track with a yuzu tick at the line.
 * Decoration only: hidden from screen readers and from the text part.
 */
export function UsageBar({ percent }: { percent: number }) {
  const used = Math.max(1, Math.min(99, Math.round(percent)));
  return (
    <table
      role="presentation"
      aria-hidden="true"
      data-skip-in-text="true"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      style={{ borderCollapse: "collapse", margin: "4px 0 0" }}
    >
      <tbody>
        <tr>
          <td
            className="pz-fill"
            width={`${used}%`}
            style={{
              height: "8px",
              backgroundColor: LIGHT.ink,
              fontSize: "1px",
              lineHeight: "8px",
            }}
          >
            &#8202;
          </td>
          <td
            width="3"
            style={{
              height: "8px",
              backgroundColor: LIGHT.yuzu,
              fontSize: "1px",
              lineHeight: "8px",
            }}
          >
            &#8202;
          </td>
          <td
            className="pz-track"
            style={{
              height: "8px",
              backgroundColor: LIGHT.hairline,
              fontSize: "1px",
              lineHeight: "8px",
            }}
          >
            &#8202;
          </td>
        </tr>
      </tbody>
    </table>
  );
}
