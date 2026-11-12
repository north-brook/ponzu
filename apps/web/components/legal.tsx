import type { ReactNode } from "react";
import { Link, Table, Td, Th } from "./prose";
import { CONTACT } from "./site";
import { STATUS_LABEL, SUBPROCESSORS, type Subprocessor } from "./subprocessors";

/*
 * The pieces the legal pages' MDX uses beside plain Markdown: an open question, a mailbox from
 * CONTACT, and the subprocessor list drawn two ways from one array (components/subprocessors.ts).
 */

/** Who answers an open question: the founder (a fact only they have) or counsel (wording). */
export type OpenFor = "founder" | "counsel";

const OPEN_LABEL: Record<OpenFor, string> = { founder: "For the founder", counsel: "For counsel" };

/**
 * A question the draft leaves open, marked where it sits so a reader sees what is not settled.
 * legal.test.ts fails while any remain once LEGAL_STATUS is "in-effect".
 */
export function Open({ who, children }: { who: OpenFor; children: ReactNode }) {
  return (
    <span
      className="rounded bg-yuzu/20 px-1 py-0.5 text-[15px] text-ink [box-decoration-break:clone]"
      data-open={who}
    >
      [{OPEN_LABEL[who]}: {children}]
    </span>
  );
}

/** One of the site's mailboxes, as a link. */
export function Mail({ to }: { to: keyof typeof CONTACT }) {
  const address = CONTACT[to];
  return <Link href={`mailto:${address}`}>{address}</Link>;
}

function Status({ row }: { row: Subprocessor }) {
  return <span className="whitespace-nowrap">{STATUS_LABEL[row.status]}</span>;
}

/** The /subprocessors page's table: every row, every column. */
export function SubprocessorTable({ rows = SUBPROCESSORS }: { rows?: readonly Subprocessor[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>What for</Th>
          <Th>What data</Th>
          <Th>Where</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.name} ${row.purpose}`} data-subprocessor={row.name}>
            <Td>
              <Link href={row.url}>{row.name}</Link>
            </Td>
            <Td>{row.purpose}</Td>
            <Td>{row.data}</Td>
            <Td>
              {row.location}
              {row.confirm ? (
                <>
                  {" "}
                  <Open who="founder">confirm {row.confirm}</Open>
                </>
              ) : null}
            </Td>
            <Td>
              <Status row={row} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The privacy policy's summary of the same list: who, what for, and whether it is in use yet. */
export function SubprocessorSummary({ rows = SUBPROCESSORS }: { rows?: readonly Subprocessor[] }) {
  return (
    <ul className="m-0 flex list-disc flex-col gap-2 pl-5 marker:text-faint">
      {rows.map((row) => (
        <li key={`${row.name} ${row.purpose}`} data-subprocessor={row.name}>
          <span className="text-ink">{row.name}</span>: {lowerFirst(row.purpose)}.
          {row.status === "when-it-ships" ? " Not in use yet; it will be when that ships." : null}
        </li>
      ))}
    </ul>
  );
}

function lowerFirst(text: string): string {
  // "Hosts the API" reads as a clause after the name; a proper noun at the start stays as it is.
  return /^[A-Z][a-z]/.test(text) && !/^(Apple|Expo|Stripe)\b/.test(text)
    ? text[0]!.toLowerCase() + text.slice(1)
    : text;
}
