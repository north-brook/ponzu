import { ApiError } from "@ponzu/client";
import {
  EFFORTS,
  type Effort,
  effortsOf,
  type ModelOption,
  type Repo,
  type WorkspaceKind,
} from "@ponzu/client/model";

/*
 * New canvas's rules (docs/mobile.md, "New canvas"), pure so bun tests them: what the statement
 * says, which project a new canvas starts in, the project picker's groups, what stops a send and
 * what a failed one says. The words follow the Mac's create page (lib/copy.ts).
 */

/** What a new canvas is made in: a repo, or Scratch. */
export type ProjectChoice = { kind: "repo"; repo: Repo } | { kind: "scratch" };

/** `north-brook/fernwood`. */
export const fullName = (repo: Repo) => `${repo.owner}/${repo.name}`;

/**
 * The statement over the composer, as the Mac's create page says it: "Make something in" over
 * the repo's full name, or "Make something from" and "scratch" on one line.
 */
export function statement(project: ProjectChoice | null): { lead: string; place: string | null } {
  if (project?.kind === "scratch") return { lead: "Make something from", place: "scratch" };
  return { lead: "Make something in", place: project ? fullName(project.repo) : null };
}

/**
 * What the project control says to VoiceOver: the project, and for Scratch whose it is, since
 * every workspace has one (the Mac's `projectName`).
 */
export function projectName(project: ProjectChoice | null, workspace: string | null): string {
  if (!project) return "Project";
  if (project.kind === "scratch")
    return workspace ? `Project: Scratch in ${workspace}` : "Project: Scratch";
  return `Project: ${fullName(project.repo)}`;
}

/**
 * The project a new canvas starts in until the person picks: the repo pushed to last, or
 * Scratch when there is none; null while the repos are still to come, so it never says Scratch
 * before it knows (the Mac's rule).
 */
export function startingProject(repos: readonly Repo[] | null): ProjectChoice | null {
  if (repos === null) return null;
  return repos[0] ? { kind: "repo", repo: repos[0] } : { kind: "scratch" };
}

/**
 * A choice still offered among `repos`: a repo the person can no longer push to (or that left
 * the workspace) falls back to where a new canvas starts.
 */
export function stillOffered(
  choice: ProjectChoice | null,
  repos: readonly Repo[] | null,
): ProjectChoice | null {
  if (!choice) return startingProject(repos);
  if (choice.kind === "scratch") return choice;
  if (repos === null) return choice;
  return repos.some((r) => r.id === choice.repo.id) ? choice : startingProject(repos);
}

/** A prompt can be sent once it says something, and not twice while the first is going. */
export function canSend(prompt: string, sending: boolean): boolean {
  return !sending && prompt.trim().length > 0;
}

/** One workspace on the picker's shelf: its repos the person can push to, null while they load. */
export interface Shelf {
  workspaceId: string;
  kind: WorkspaceKind;
  name: string;
  repos: Repo[] | null;
}

/** The picker's shelves in its order: the person's own workspace first, then the others as given. */
export function orderShelves(shelves: readonly Shelf[]): Shelf[] {
  return [
    ...shelves.filter((s) => s.kind === "personal"),
    ...shelves.filter((s) => s.kind !== "personal"),
  ];
}

/** One workspace's part of the picker's list. */
export interface PickerGroup {
  workspaceId: string;
  /** The workspace's name over the group; null when it is the only one. */
  heading: string | null;
  scratch: boolean;
  repos: Repo[];
  /** Its repos are still to come. */
  loading: boolean;
}

/**
 * The picker's list for a search, grouped by workspace (personal first): each group is its
 * Scratch, then its repos, pushed to lately first. A search keeps the repos whose full name has
 * it anywhere, and Scratch for "scratch"; with several workspaces a workspace's name finds its
 * whole group. A group with nothing left is left out. A repo listed already is not listed twice.
 * The Mac's `pickerGroups`, with the phone's order.
 */
export function pickerGroups(shelves: readonly Shelf[], query: string): PickerGroup[] {
  const q = query.trim().toLowerCase();
  const has = (text: string) => !q || text.toLowerCase().includes(q);
  const ordered = orderShelves(shelves);
  const several = ordered.length > 1;
  const seen = new Set<string>();
  const groups: PickerGroup[] = [];
  for (const shelf of ordered) {
    const named = several && q !== "" && has(shelf.name);
    const repos = (shelf.repos ?? []).filter((repo) => {
      if (seen.has(repo.id)) return false;
      seen.add(repo.id);
      return named || has(fullName(repo));
    });
    const scratch = named || has("scratch");
    const loading = shelf.repos === null && !q;
    if (!scratch && !repos.length && !loading) continue;
    groups.push({
      workspaceId: shelf.workspaceId,
      heading: several ? shelf.name : null,
      scratch,
      repos,
      loading,
    });
  }
  return groups;
}

/** A picker row's key: a repo's id, or `scratch:<workspace>`. */
export function choiceKey(choice: ProjectChoice, workspaceId: string): string {
  return choice.kind === "repo" ? choice.repo.id : `scratch:${workspaceId}`;
}

/** A model and the effort it runs at. */
export interface ModelChoice {
  model: string;
  effort: Effort;
}

/** What `GET /v1/claude/defaults` answers: the person's defaults and what their Claude offers. */
export interface ClaudeDefaults extends ModelChoice {
  models: readonly ModelOption[];
  efforts: readonly Effort[];
}

/**
 * The model and effort a new canvas runs on: the last ones picked on this phone while the
 * account still offers them (a model that takes no effort carries one all the same, which the
 * API lets by), else the person's defaults; null until the defaults are known, when a canvas
 * sent starts on them anyway. The Mac's rule.
 */
export function modelChoice(
  saved: ModelChoice | null,
  defaults: ClaudeDefaults | undefined,
): ModelChoice | null {
  if (!defaults) return null;
  if (saved && defaults.models.some((m) => m.id === saved.model)) {
    const takes = effortsOf(defaults.models, defaults.efforts, saved.model);
    if (takes.length === 0 || takes.includes(saved.effort)) return saved;
  }
  return { model: defaults.model, effort: defaults.effort };
}

/** A kept choice read back from storage, or null for anything else. */
export function readModelChoice(text: string | null): ModelChoice | null {
  try {
    const saved = JSON.parse(text ?? "null") as Partial<ModelChoice> | null;
    return typeof saved?.model === "string" &&
      (EFFORTS as readonly string[]).includes(saved.effort as string)
      ? { model: saved.model, effort: saved.effort as Effort }
      : null;
  } catch {
    return null;
  }
}

/** Where the last model and effort picked here are kept: ids, never a secret. */
export const MODEL_CHOICE_KEY = "ponzu.create.model";

/** What a send must wait for, read from `GET /v1/me`. */
export type Blocked =
  /** No Claude connected, or its sign-in ran out: connect it, and the prompt goes. */
  | { kind: "claude"; connected: boolean; expired: boolean }
  /** The plan is at a limit until `until`: the canvas would wait for it. */
  | { kind: "limited"; until: string };

interface MeClaude {
  claudeAccount: { status: string; limitedUntil?: string | Date | null } | null;
}

/**
 * What stops a send now, or null when it can go. Before `me` has come (still on its way, or the
 * phone offline with no copy of it) nothing is known to stop it: the send goes, and the API
 * answers for itself, so someone offline reads that Ponzu can't be reached rather than being
 * asked to connect a Claude they already have.
 */
export function blockedOnSend(me: MeClaude | undefined, now: number): Blocked | null {
  if (me === undefined) return null;
  const account = me.claudeAccount ?? null;
  if (!account || account.status !== "connected") {
    return { kind: "claude", connected: account !== null, expired: account?.status === "expired" };
  }
  const until = account.limitedUntil ? new Date(account.limitedUntil) : null;
  if (until && !Number.isNaN(until.getTime()) && until.getTime() > now) {
    return { kind: "limited", until: until.toISOString() };
  }
  return null;
}

/** "9:00" or "16:30": the Mac writes times on a 24-hour clock without a leading zero. */
function clock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** When a plan's limit resets, in the phone's time zone: "16:30" today, else "Monday 16:30". */
export function resetTime(until: string, now: number): string {
  const at = new Date(until);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return clock(at);
  return `${at.toLocaleDateString("en-US", { weekday: "long" })} ${clock(at)}`;
}

/**
 * The first sentence of what the API said: a billing refusal's neutral part, with nothing after
 * it that asks anyone to pay (App Store 3.1.3(f); the program's settlement 6).
 */
export function firstSentence(message: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(message.trim());
  return (match ? match[0] : message).trim();
}

/**
 * The line a failed send leaves under the composer, the Mac's words. `made` is true when the
 * canvas was made and only its pictures or first message didn't go: sent again, they go to that
 * canvas, so the line must not say it wasn't made.
 */
export function sendFailure(error: unknown, made = false): string {
  if (error instanceof ApiError) {
    if (error.code === "network") {
      return "Ponzu can't be reached. Check your connection and send it again.";
    }
    if (error.code === "model_not_offered") {
      return "Your Claude account doesn't offer that model any more. Check the model and send it again.";
    }
    // At a billing limit: what the workspace's state is, and nothing more (billing B6 owns
    // the rest of the phone's words).
    if (error.status === 402 && error.message) return firstSentence(error.message);
  }
  if (made) return "The canvas is made, but your message didn't go with it. Send it again.";
  return "That canvas couldn't be made. Try again.";
}
