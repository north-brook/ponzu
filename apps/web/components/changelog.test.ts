import { expect, test } from "bun:test";
import {
  CHANGELOG_URL,
  latestChangelog,
  noteParts,
  parseChangelog,
  releaseDay,
  releaseName,
  SINCE,
} from "./changelog";
import recorded from "./changelog.fixture.json";

/*
 * changelog.fixture.json is `bun scripts/release-notes.ts --changelog` run on this repository's
 * history (12 Nov 2026), trimmed to its newest four desktop and three iPhone releases. They're
 * all Ponzu 1's, so the real start leaves none of them; a lower one shows how they read.
 */

const ONE_X = { mac: "1.79.1", iphone: "0.11.5" };

/** A changelog.json once Ponzu Cloud has shipped, in the shape the release tooling writes. */
const cloud = {
  mac: [
    { version: "2.1.0", date: "2026-11-20T18:15:00-05:00", notes: ["Pins stay put."] },
    { version: "2.0.0", date: "2026-11-18T09:00:00Z", notes: ["Make it on the canvas."] },
    { version: "1.80.1", date: "2026-11-10T00:19:33-05:00", notes: ["Ponzu 1's last."] },
  ],
  iphone: [
    { version: "1.0.2", date: "2026-11-21T10:00:00Z", notes: ["   ", ""] },
    { version: "1.0.1", date: "2026-11-20T23:15:00Z", notes: [" Answers wait offline. ", ""] },
    { version: "1.0.0", date: "2026-11-18T09:00:00Z", notes: ["Comment from your phone."] },
    { version: "0.12.1", date: "2026-11-11T09:00:00Z", notes: ["Ponzu 1's phone."] },
  ],
};

test("the changelog starts at Ponzu Cloud's first release of each app", () => {
  expect(SINCE).toEqual({ mac: "2.0.0", iphone: "1.0.0" });
  // The recorded releases are all Ponzu 1's: none shows, and that isn't a failure to load.
  expect(parseChangelog(recorded)).toEqual([]);
});

test("a recorded changelog.json reads as both apps' releases, newest first", () => {
  expect(parseChangelog(recorded, ONE_X)).toEqual([
    {
      app: "mac",
      version: "1.80.1",
      date: "2026-11-10T00:19:33-05:00",
      notes: [
        "The comment field stays its usual size while listening, with the waveform, words and keyboard button centred.",
        "Boards stay drawn while you zoom in and out.",
      ],
    },
    {
      app: "iphone",
      version: "0.12.0",
      date: "2026-11-10T00:21:18Z",
      notes: [
        "Comments are written in one floating field, without a sheet: typed or spoken words go in the same place, and Send sits inside it.",
      ],
    },
    {
      app: "mac",
      version: "1.79.2",
      date: "2026-11-09T22:45:53Z",
      notes: [
        "Notes, diagrams and docs your agent draws to explain its work now match your canvas in dark mode.",
      ],
    },
    {
      app: "iphone",
      version: "0.11.5",
      date: "2026-11-09T22:25:29Z",
      notes: ["The comment field grows again as you type past one line."],
    },
    {
      app: "mac",
      version: "1.79.1",
      date: "2026-11-09T15:00:18Z",
      notes: [
        "Artboards keep their id, size and content while a script is still writing their file.",
      ],
    },
  ]);
});

test("both apps merge by the moment each was tagged, the desktop first on a tie", () => {
  const entries = parseChangelog(cloud)!;
  expect(entries.map(releaseName)).toEqual([
    // The phone's 1.0.2 has only blank notes, so it isn't shown. 18:15 at -05:00 is 23:15 in
    // UTC, the same moment as the phone's 1.0.1; 2.0.0 and 1.0.0 were tagged together too.
    "Ponzu 2.1.0",
    "Ponzu for iPhone 1.0.1",
    "Ponzu 2.0.0",
    "Ponzu for iPhone 1.0.0",
  ]);
  expect(entries[1]!.notes).toEqual(["Answers wait offline."]);
  expect(entries.map((e) => releaseDay(e.date))).toEqual([
    "November 20, 2026",
    "November 20, 2026",
    "November 18, 2026",
    "November 18, 2026",
  ]);
  // The tagger's own calendar day, wherever the site renders it.
  expect(releaseDay("2026-11-20T23:30:00-05:00")).toBe("November 20, 2026");
  expect(releaseDay("2026-01-01T00:10:00+09:00")).toBe("January 1, 2026");
});

test("a file in another shape, or written without history, counts as missing", () => {
  expect(parseChangelog({ ...cloud, incomplete: true })).toBeNull();
  expect(parseChangelog({ mac: [], iphone: [], incomplete: true })).toBeNull();
  expect(parseChangelog({ releases: [{ version: "2.0.0", notes: ["x"] }] })).toBeNull();
  expect(parseChangelog({ mac: cloud.mac })).toBeNull();
  expect(parseChangelog(null)).toBeNull();
  expect(parseChangelog("2.0.0")).toBeNull();
  for (const bad of [
    { version: "v2.0.0", date: "2026-11-18T09:00:00Z", notes: [] },
    { version: "2.0.0", date: "November 18", notes: [] },
    { version: "2.0.0", date: "2026-11-18T09:00:00Z", notes: [1] },
    { version: "2.0.0", date: "2026-11-18T09:00:00Z" },
  ])
    expect(parseChangelog({ mac: [bad], iphone: [] })).toBeNull();
  // No release of either app has notes yet: an empty list, which the page says plainly.
  expect(parseChangelog({ mac: [], iphone: [] })).toEqual([]);
});

test("a note's backticked words are set as code, and nothing else is read as markup", () => {
  // Two of Ponzu 1.78.0's real notes.
  expect(noteParts("`record` films a scene as a storyboard.")).toEqual([
    { code: true, text: "record" },
    { code: false, text: " films a scene as a storyboard." },
  ]);
  expect(noteParts('Artboards play demos: a `<script type="ponzu/act">` scene moves.')).toEqual([
    { code: false, text: "Artboards play demos: a " },
    { code: true, text: '<script type="ponzu/act">' },
    { code: false, text: " scene moves." },
  ]);
  expect(noteParts("Hold ` to pan, and **bold** stays as written.")).toEqual([
    { code: false, text: "Hold ` to pan, and **bold** stays as written." },
  ]);
  expect(noteParts("")).toEqual([]);
});

/** A fetch that answers `respond`, and keeps what it was asked. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  // Next's types give RequestInit its `next` options.
  const calls: { url: string; init?: RequestInit }[] = [];
  const load = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { load, calls };
}

test("the latest release's changelog.json is read hourly, with a deadline", async () => {
  const { load, calls } = fakeFetch(() => Response.json(cloud));
  const entries = await latestChangelog(load);
  expect(entries).toHaveLength(4);
  expect(entries).toEqual(parseChangelog(cloud));
  expect(CHANGELOG_URL).toBe(
    "https://github.com/north-brook/ponzu/releases/latest/download/changelog.json",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(CHANGELOG_URL);
  expect(calls[0]!.init?.next).toEqual({ revalidate: 3600 });
  expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
});

test("a failed fetch, a missing file or a body that isn't the changelog falls back, never throws", async () => {
  const cases: (() => Response | Promise<Response>)[] = [
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    () => new Response("Not Found", { status: 404 }),
    () => new Response("<html>rate limited</html>", { status: 200 }),
    () => Response.json({ mac: "2.0.0", iphone: [] }),
    () => Response.json({ mac: [], iphone: [], incomplete: true }),
  ];
  for (const respond of cases) expect(await latestChangelog(fakeFetch(respond).load)).toBeNull();
});
