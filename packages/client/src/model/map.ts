import type { Api } from "../api.ts";
import type { CanvasListRow, PresenceRow } from "../live/rows.ts";
import type {
  CanvasAccess,
  CanvasMember,
  CanvasPreview,
  CanvasSummary,
  Contributor,
  Match,
  PageTab,
  Person,
  Project,
  Repo,
  SearchResults,
  Workspace,
} from "./model.ts";

/*
 * The API's answers and live rows as the UI's model (model.ts). Pure, so the rules a
 * person sees (what counts as unseen, who is here, what a Scratch canvas is called) are tested
 * on their own.
 */

type MeWorkspace = Awaited<ReturnType<Api["me"]>>["workspaces"][number];
type WorkspaceView = Awaited<ReturnType<Api["workspaces"]["get"]>>;
type RepoView = WorkspaceView["repos"][number];
type MemberView = WorkspaceView["members"][number];
type CanvasPeopleView = Awaited<ReturnType<Api["canvases"]["people"]>>;

/** What anyone the API names carries: a person, a member, someone present. */
interface Someone {
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
}

export function toPerson(id: string, someone: Someone): Person {
  return {
    id,
    name: someone.name?.trim() || someone.githubLogin,
    login: someone.githubLogin,
    avatarUrl: someone.avatarUrl,
  };
}

/** A workspace in the switcher. */
export function toWorkspace(workspace: MeWorkspace): Workspace {
  return {
    id: workspace.id,
    kind: workspace.kind,
    name: workspace.kind === "personal" ? "Personal" : workspace.name,
    login: workspace.githubLogin,
    avatarUrl: workspace.avatarUrl,
  };
}

/** One that lost the App, or is suspended, can't be worked in: it isn't offered. */
export function usableWorkspaces(workspaces: MeWorkspace[]): MeWorkspace[] {
  return workspaces.filter((workspace) => workspace.installed && !workspace.suspended);
}

/** The workspace the window shows: the one last chosen while it is usable, else the first. */
export function shownWorkspace(
  workspaces: MeWorkspace[],
  chosenId: string | null,
): MeWorkspace | null {
  const usable = usableWorkspaces(workspaces);
  return usable.find((w) => w.id === chosenId) ?? usable[0] ?? null;
}

/** `north-brook/ponzu` as the UI's repo. */
export function toRepo(id: string, fullName: string): Repo {
  const slash = fullName.indexOf("/");
  return { id, owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/** The repos a new canvas can be made in: those the person can push to, pushed-to lately first. */
export function pushableRepos(repos: RepoView[]): Repo[] {
  return repos
    .filter((repo) => repo.canPush)
    .toSorted((a, b) => String(b.pushedAt ?? "").localeCompare(String(a.pushedAt ?? "")))
    .map((repo) => toRepo(repo.id, repo.fullName));
}

/** Before the agent has made its branch, a repo canvas's row says so instead of naming one. */
export const NO_BRANCH_YET = "new branch";
/** Scratch canvases have no city of their own yet: the row says where they live. */
export const SCRATCH_PLACE = "Scratch";

export function toProject(row: Pick<CanvasListRow, "repoId" | "repoFullName" | "branch">): Project {
  if (row.repoId && row.repoFullName) {
    return {
      kind: "repo",
      repo: toRepo(row.repoId, row.repoFullName),
      branch: row.branch ?? NO_BRANCH_YET,
    };
  }
  return { kind: "scratch", city: SCRATCH_PLACE };
}

/**
 * A canvas moved since the person last looked: its log is past what they saw. One they have
 * never opened counts once it has anything in it, so a teammate's new canvas shows.
 */
export function isUnseen(row: Pick<CanvasListRow, "seq" | "seenSeq">): boolean {
  return row.seq > (row.seenSeq ?? 0);
}

/** A canvas's previews, as docs/cloud.md addresses them: `<assets url>previews/<seq>-<theme>.png`. */
export function previewOf(assetsUrl: string, previewSeq: number | null): CanvasPreview | null {
  if (previewSeq === null) return null;
  const base = `${assetsUrl}previews/${previewSeq}`;
  return { light: `${base}-light.png`, dark: `${base}-dark.png` };
}

/**
 * `next`, with every part equal to `previous`'s taken from `previous`: a live update that changed
 * one row's status hands back the other rows, and that row's preview, project and people, as the
 * same objects. The sidebar draws a row, and a row its picture, again only when its own parts
 * change. For plain data: objects, arrays and primitives.
 */
export function keepUnchanged<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (typeof previous !== "object" || typeof next !== "object" || !previous || !next) return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  if (Object.getPrototypeOf(next) !== Object.prototype && !Array.isArray(next)) return next;
  const was = previous as Record<string, unknown>;
  const now = next as Record<string, unknown>;
  // A list of rows is matched by id, so a row moving up the list is still the same row.
  const byId =
    Array.isArray(previous) &&
    new Map<unknown, unknown>(
      (previous as unknown[]).flatMap((item): [unknown, unknown][] =>
        item && typeof item === "object" && "id" in item ? [[item.id, item]] : [],
      ),
    );
  const out = (Array.isArray(next) ? [] : {}) as Record<string, unknown>;
  let same = Object.keys(was).length === Object.keys(now).length;
  for (const key of Object.keys(now)) {
    const item = now[key];
    const match =
      byId && item && typeof item === "object" && "id" in item
        ? byId.get((item as { id: unknown }).id)
        : was[key];
    const kept = keepUnchanged(match, item);
    out[key] = kept;
    if (!Object.is(kept, was[key])) same = false;
  }
  return same ? previous : (out as T);
}

export function toSummary(
  row: CanvasListRow,
  context: {
    /** The workspace's members by id: whose a canvas is. */
    people: ReadonlyMap<string, Person>;
    /** Teammates in it now, when the app knows. */
    hereNow?: Person[];
    /** The canvas open in the window is being seen, whatever the row last said. */
    open?: boolean;
    /** Where its files are, once the API has said: its previews are there. */
    assetsUrl?: string;
  },
): CanvasSummary {
  return {
    id: row.id,
    name: row.name,
    project: toProject(row),
    preview: context.assetsUrl ? previewOf(context.assetsUrl, row.previewSeq) : null,
    status: row.status,
    agentState: row.agentState,
    needsYou: row.needsYouCount,
    unseen: !context.open && isUnseen(row),
    pullRequest:
      row.prNumber !== null && row.prState !== null
        ? {
            number: row.prNumber,
            state: row.prState,
            checks: row.prChecks,
            mergeable: null,
            autoMerge: false,
          }
        : null,
    hereNow: context.hereNow ?? [],
    owner: row.ownerId ? (context.people.get(row.ownerId) ?? null) : null,
    lastActivityAt: row.lastActivityAt,
    settledAt: row.settledAt,
  };
}

export function membersById(members: MemberView[]): Map<string, Person> {
  return new Map(members.map((member) => [member.userId, toPerson(member.userId, member)]));
}

/** Who has the canvas open, by their rows, the viewer left out. */
export function hereNow(rows: readonly PresenceRow[], meId: string): Person[] {
  return rows.filter((row) => row.userId !== meId).map((row) => toPerson(row.userId, row));
}

/**
 * The chrome's avatars: the viewer, everyone else here now, then whoever has worked on it and
 * is away, faded, with when they were last in it (as far as the thread says).
 */
export function contributors(
  rows: readonly PresenceRow[],
  me: Person,
  worked: readonly { person: Person; at: string }[] = [],
): Contributor[] {
  const here = [me, ...hereNow(rows, me.id)];
  const away = worked.filter(({ person }) => !here.some((p) => p.id === person.id));
  return [
    ...here.map((person) => ({ person, here: true, lastHereAt: null })),
    ...away.map(({ person, at }) => ({ person, here: false, lastHereAt: at })),
  ];
}

/**
 * Who can reach the canvas, as Share lists it: everyone GitHub gives access to its repo, as the
 * API says (`canvases.people`), whether or not they have opened Ponzu, its owner first. Until
 * that answer is in (or from an API that doesn't give it), the workspace's members who have
 * opened Ponzu, everyone but the owner editing.
 */
export function canvasMembers(
  members: MemberView[],
  ownerId: string | null,
  people?: CanvasPeopleView["people"],
): CanvasMember[] {
  if (people) {
    return people.map((someone) => ({
      person: toPerson(someone.userId ?? githubPersonId(someone.githubUserId), someone),
      access: someone.access,
      joined: someone.joined,
    }));
  }
  return members
    .map((member) => {
      const access: CanvasAccess = member.userId === ownerId ? "owner" : "edit";
      return { person: toPerson(member.userId, member), access, joined: true };
    })
    .toSorted((a, b) => Number(b.access === "owner") - Number(a.access === "owner"));
}

/** The id the UI keys someone by before they have a Ponzu user: their GitHub id. */
export function githubPersonId(githubUserId: number): string {
  return `github:${githubUserId}`;
}

/**
 * Search, over what the window already has: the canvases' names, every place the query appears.
 * Boards and comments need the API's search, which isn't there yet, so they find nothing.
 */
export function searchByName(query: string, canvases: CanvasSummary[]): SearchResults {
  const q = query.trim().toLowerCase();
  const hits = canvases.flatMap((canvas) => {
    const name = canvas.name.toLowerCase();
    const matches: Match[] = [];
    for (let at = name.indexOf(q); q && at >= 0; at = name.indexOf(q, at + q.length)) {
      matches.push([at, at + q.length]);
    }
    return matches.length ? [{ canvas, matches }] : [];
  });
  return { query, canvases: hits, boards: [], comments: [] };
}

/** The open canvas's pages as tabs; a page holding a board the agent is on is working. */
export function pageTabs(
  pages: readonly {
    id: string;
    name: string;
    icon?: string;
    artboards: readonly { id: string }[];
  }[],
  agentArtboards: readonly string[],
): PageTab[] {
  return pages.map((page) => ({
    id: page.id,
    name: page.name,
    icon: page.icon ?? null,
    working: page.artboards.some((board) => agentArtboards.includes(board.id)),
  }));
}
