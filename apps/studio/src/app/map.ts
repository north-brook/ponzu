import type { Api, DesignListRow, PresenceRow } from "@ponzu/client";
import type {
  Contributor,
  DesignAccess,
  DesignMember,
  DesignPreview,
  DesignSummary,
  Match,
  PageTab,
  Person,
  Project,
  Repo,
  SearchResults,
  Workspace,
} from "../cloud/model.ts";

/*
 * The API's answers and live rows as the UI's model (cloud/model.ts). Pure, so the rules a
 * person sees (what counts as unseen, who is here, what a Scratch design is called) are tested
 * on their own.
 */

type MeWorkspace = Awaited<ReturnType<Api["me"]>>["workspaces"][number];
type WorkspaceView = Awaited<ReturnType<Api["workspaces"]["get"]>>;
type RepoView = WorkspaceView["repos"][number];
type MemberView = WorkspaceView["members"][number];
type DesignPeopleView = Awaited<ReturnType<Api["designs"]["people"]>>;

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

/** The repos a new design can be made in: those the person can push to, pushed-to lately first. */
export function pushableRepos(repos: RepoView[]): Repo[] {
  return repos
    .filter((repo) => repo.canPush)
    .toSorted((a, b) => String(b.pushedAt ?? "").localeCompare(String(a.pushedAt ?? "")))
    .map((repo) => toRepo(repo.id, repo.fullName));
}

/** Before the agent has made its branch, a repo design's row says so instead of naming one. */
export const NO_BRANCH_YET = "new branch";
/** Scratch designs have no city of their own yet: the row says where they live. */
export const SCRATCH_PLACE = "Scratch";

export function toProject(row: Pick<DesignListRow, "repoId" | "repoFullName" | "branch">): Project {
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
 * A design moved since the person last looked: its log is past what they saw. One they have
 * never opened counts once it has anything in it, so a teammate's new design shows.
 */
export function isUnseen(row: Pick<DesignListRow, "seq" | "seenSeq">): boolean {
  return row.seq > (row.seenSeq ?? 0);
}

/** A design's previews, as docs/cloud.md addresses them: `<assets url>previews/<seq>-<theme>.png`. */
export function previewOf(assetsUrl: string, previewSeq: number | null): DesignPreview | null {
  if (previewSeq === null) return null;
  const base = `${assetsUrl}previews/${previewSeq}`;
  return { light: `${base}-light.png`, dark: `${base}-dark.png` };
}

export function toSummary(
  row: DesignListRow,
  context: {
    /** The workspace's members by id: whose a design is. */
    people: ReadonlyMap<string, Person>;
    /** Teammates in it now, when the app knows. */
    hereNow?: Person[];
    /** The design open in the window is being seen, whatever the row last said. */
    open?: boolean;
    /** Where its files are, once the API has said: its previews are there. */
    assetsUrl?: string;
  },
): DesignSummary {
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

/** Who has the design open, by their rows, the viewer left out. */
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
 * Who can reach the design, as Share lists it: everyone GitHub gives access to its repo, as the
 * API says (`designs.people`), whether or not they have opened Ponzu, its owner first. Until
 * that answer is in (or from an API that doesn't give it), the workspace's members who have
 * opened Ponzu, everyone but the owner editing.
 */
export function designMembers(
  members: MemberView[],
  ownerId: string | null,
  people?: DesignPeopleView["people"],
): DesignMember[] {
  if (people) {
    return people.map((someone) => ({
      person: toPerson(someone.userId ?? githubPersonId(someone.githubUserId), someone),
      access: someone.access,
      joined: someone.joined,
    }));
  }
  return members
    .map((member) => {
      const access: DesignAccess = member.userId === ownerId ? "owner" : "edit";
      return { person: toPerson(member.userId, member), access, joined: true };
    })
    .toSorted((a, b) => Number(b.access === "owner") - Number(a.access === "owner"));
}

/** The id the UI keys someone by before they have a Ponzu user: their GitHub id. */
export function githubPersonId(githubUserId: number): string {
  return `github:${githubUserId}`;
}

/**
 * Search, over what the window already has: the designs' names, every place the query appears.
 * Boards and comments need the API's search, which isn't there yet, so they find nothing.
 */
export function searchByName(query: string, designs: DesignSummary[]): SearchResults {
  const q = query.trim().toLowerCase();
  const hits = designs.flatMap((design) => {
    const name = design.name.toLowerCase();
    const matches: Match[] = [];
    for (let at = name.indexOf(q); q && at >= 0; at = name.indexOf(q, at + q.length)) {
      matches.push([at, at + q.length]);
    }
    return matches.length ? [{ design, matches }] : [];
  });
  return { query, designs: hits, boards: [], comments: [] };
}

/** The open design's pages as tabs; a page holding a board the agent is on is working. */
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
