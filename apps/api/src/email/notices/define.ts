/*
 * What a legal notice file holds (docs/cloud.md, "Email"). Each notice Ponzu's terms or privacy
 * policy promise by email is one file in this folder, named for its id, holding its kind, the
 * day it takes effect and any summary in Ponzu's own words. The words are reviewed in a pull
 * request like any other; the fixed sentences around them are @ponzu/email's. The founder sends
 * a notice with apps/api/scripts/notice.ts, never a trigger.
 */

/** A day, `YYYY-MM-DD`, read in UTC: notices promise calendar days, not moments. */
export type NoticeDay = `${number}-${number}-${number}`;

interface Common {
  /** The file's name without `.ts`, and the id its records carry: lowercase, digits and `-`. */
  id: string;
  /**
   * True for a notice that only checks the script on dev: it is refused on production, so no
   * real person ever gets it.
   */
  devOnly?: boolean;
}

/** A notice that names the day it takes effect. Null until the founder writes the day. */
interface Dated {
  effective: NoticeDay | null;
}

export type NoticeFile = Common &
  (
    | (Dated & { kind: "billing_starts" })
    | (Dated & {
        kind: "price_rise";
        /** The old and new price of a credit, as people read them ("$0.10", "$0.12"). */
        oldPrice: string;
        newPrice: string;
      })
    | (Dated & {
        kind: "terms_change" | "privacy_change";
        /** What changes, one paragraph each. The first is also the preview. */
        summary: readonly [string, ...string[]];
      })
    | (Dated & { kind: "shutdown"; summary: readonly string[] })
    | {
        /**
         * A suspension: the people and the reason are the founder's, given to the script
         * (`--user`, `--reason-file`, `--case`), never written here.
         */
        kind: "suspension";
      }
  );

export type NoticeKind = NoticeFile["kind"];

export function defineNotice<const N extends NoticeFile>(notice: N): N {
  return notice;
}
