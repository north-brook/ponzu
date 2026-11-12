import type { Api } from "../api.ts";
import type { Clock } from "../clock.ts";
import { ApiError } from "../errors.ts";

/*
 * The Settings routes in memory, for the fake backend: ping toggles and devices, repos'
 * environments, a workspace's usage and cap, deleting the account. The rules are the API's
 * (apps/api: routes/notifications.ts, environments.ts, usage.ts, account.ts), kept to what a
 * screen or a story can tell apart.
 */

export type SettingsApi = Pick<
  Api,
  "notifications" | "devices" | "environments" | "usage" | "privacy" | "account"
>;

type Prefs = Awaited<ReturnType<Api["notifications"]["get"]>>["prefs"];
type Device = Awaited<ReturnType<Api["notifications"]["get"]>>["devices"][number];
type Environment = Awaited<ReturnType<Api["environments"]["get"]>>["environment"];
type Base = Environment["base"];
type Usage = Awaited<ReturnType<Api["usage"]["get"]>>;

const DEFAULT_PREFS: Prefs = {
  needsYou: true,
  replies: true,
  prReady: true,
  teammateComments: false,
  emailDigest: false,
};

/** The launch rate card: $0.10 a credit, 100 free per member, a $100 cap by default. */
const CREDIT_CENTS = 10;
const FREE_PER_MEMBER = 100;
const DEFAULT_CAP_USD = 100;

/** What the fake backend lends the settings: who may see what, as its other routes decide. */
export interface SettingsWorld {
  call<T>(run: () => T): Promise<T>;
  /** The workspace and the person's role in it; 404 when they are not a member. */
  member(workspaceId: string): {
    workspace: { id: string; members: Map<string, "admin" | "member"> };
    role: "admin" | "member";
  };
  /** A repo the person can read, its workspace and whether they can push; 404 otherwise. */
  repo(repoId: string): { id: string; fullName: string; workspaceId: string; canPush: boolean };
  /** The repos of a workspace the person can read. */
  repos(workspaceId: string): { id: string }[];
  /** Some canvas was made on the repo: its start builds the repo's base. */
  hasCanvasIn(repoId: string): boolean;
  person(userId: string): {
    id: string;
    name: string | null;
    githubLogin: string;
    avatarUrl: string | null;
  };
  /** The teams the person is the only admin of while others are in them. */
  soleAdminOf(userId: string): { id: string; name: string }[];
  /** Take the person out of every workspace and forget them. */
  forget(userId: string): void;
  /** The person's own row changed: the live `me` row says so. */
  meChanged(): void;
}

export class FakeSettings {
  readonly prefs = new Map<string, Prefs>();
  /** Share usage data, by person: on unless they turned it off. */
  readonly sharing = new Map<string, boolean>();
  readonly devices = new Map<string, Device[]>();
  readonly secrets = new Map<string, { name: string; updatedAt: string }[]>();
  readonly bases = new Map<string, Base>();
  /** Credits used this period, by workspace and person. */
  readonly used = new Map<string, Map<string, number>>();
  readonly caps = new Map<string, number>();
  private ids = 0;

  constructor(private readonly clock: Clock) {}

  /** A repo's base, as Claude would have built it. */
  setBase(repoId: string, base: Partial<Base>): void {
    this.bases.set(repoId, { ...this.base(repoId), ...base });
  }

  /** Credits a person used in a workspace this period. */
  use(workspaceId: string, userId: string, credits: number): void {
    const byPerson = this.used.get(workspaceId) ?? new Map<string, number>();
    byPerson.set(userId, (byPerson.get(userId) ?? 0) + credits);
    this.used.set(workspaceId, byPerson);
  }

  apiFor(userId: string, world: SettingsWorld): SettingsApi {
    const { call } = world;
    const now = () => new Date(this.clock.now()).toISOString();
    const prefs = () => this.prefs.get(userId) ?? DEFAULT_PREFS;
    const mine = () => this.devices.get(userId) ?? [];
    const notifications = () => ({ prefs: prefs(), devices: mine() });
    const device = (id: string) => {
      const found = mine().find((d) => d.id === id);
      if (!found) throw new ApiError(404, "not_found", "There is no such device.");
      return found;
    };
    const environment = (repoId: string) => {
      const repo = world.repo(repoId);
      const { role } = world.member(repo.workspaceId);
      const [owner = "", name = ""] = repo.fullName.split("/");
      return {
        environment: {
          repo: { id: repo.id, owner, name, fullName: repo.fullName },
          base: this.base(repo.id),
          secrets: this.secrets.get(repo.id) ?? [],
        },
        canManageSecrets: role === "admin",
        canRebuild: repo.canPush,
      };
    };
    const secretsAdmin = (repoId: string) => {
      const repo = world.repo(repoId);
      if (world.member(repo.workspaceId).role !== "admin") {
        throw new ApiError(403, "forbidden", "Only an admin of this workspace can do this.");
      }
      return this.secrets.get(repo.id) ?? [];
    };
    const usage = (workspaceId: string): Usage => {
      const { workspace, role } = world.member(workspaceId);
      const used = this.used.get(workspace.id) ?? new Map<string, number>();
      const usedCredits = [...used.values()].reduce((sum, n) => sum + n, 0);
      const freeCredits = workspace.members.size * FREE_PER_MEMBER;
      const billedCredits = Math.max(0, usedCredits - freeCredits);
      const billedCents = billedCredits * CREDIT_CENTS;
      const row = (id: string) => ({
        person: (({ id: pid, name, githubLogin, avatarUrl }) => ({
          id: pid,
          name: name ?? githubLogin,
          login: githubLogin,
          avatarUrl,
        }))(world.person(id)),
        admin: workspace.members.get(id) === "admin",
        usedCredits: used.get(id) ?? 0,
      });
      const start = new Date(this.clock.now());
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const admin = role === "admin";
      return {
        period: { start: start.toISOString(), end: end.toISOString() },
        creditCents: CREDIT_CENTS,
        usedCredits,
        freeCredits,
        billedCredits,
        billedCents,
        people: workspace.members.size,
        cap: {
          usd: this.caps.get(workspace.id) ?? DEFAULT_CAP_USD,
          isDefault: !this.caps.has(workspace.id),
          lowestUsd: Math.max(1, Math.ceil(billedCents / 100)),
        },
        billing: { status: "not_set_up", card: null, invoices: "not_set_up" },
        canManage: admin,
        mine: row(userId),
        byPerson: admin
          ? [...workspace.members.keys()].map(row).sort((a, b) => b.usedCredits - a.usedCredits)
          : null,
        unattributedCredits: admin ? 0 : null,
        byCanvas: admin ? [] : null,
      };
    };

    return {
      notifications: {
        get: () => call(notifications),
        set: (changes) =>
          call(() => {
            this.prefs.set(userId, { ...prefs(), ...changes });
            return notifications();
          }),
      },
      devices: {
        register: (body) =>
          call(() => {
            const device: Device = {
              id: `dev_${++this.ids}`,
              platform: body.platform,
              name: body.name ?? null,
              appVersion: body.appVersion ?? null,
              pings: true,
              blocked: body.blocked ?? false,
              lastSeenAt: now(),
              createdAt: now(),
            };
            this.devices.set(userId, [device, ...mine()]);
            return { device };
          }),
        update: (id, { pings, blocked, name, appVersion }) =>
          call(() => {
            const changed: Device = {
              ...device(id),
              ...(pings === undefined ? {} : { pings }),
              ...(blocked === undefined ? {} : { blocked }),
              ...(name === undefined ? {} : { name }),
              ...(appVersion === undefined ? {} : { appVersion }),
              lastSeenAt: now(),
            };
            this.devices.set(
              userId,
              mine().map((d) => (d.id === id ? changed : d)),
            );
            return { device: changed };
          }),
        remove: (id) =>
          call(() => {
            device(id);
            this.devices.set(
              userId,
              mine().filter((d) => d.id !== id),
            );
          }),
      },
      environments: {
        list: (workspaceId) =>
          call(() => {
            const { role } = world.member(workspaceId);
            return {
              repos: world
                .repos(workspaceId)
                // As the API: once it has a canvas, a base or a secret.
                .filter(
                  (repo) =>
                    world.hasCanvasIn(repo.id) ||
                    this.bases.has(repo.id) ||
                    this.secrets.has(repo.id),
                )
                .map((repo) => environment(repo.id).environment),
              canManageSecrets: role === "admin",
            };
          }),
        get: (repoId) => call(() => environment(repoId)),
        rebuild: (repoId) =>
          call(() => {
            if (!world.repo(repoId).canPush) {
              throw new ApiError(403, "forbidden", "You can read this repo but not push to it.");
            }
            this.setBase(repoId, { rebuild: { requestedAt: now(), waiting: false } });
            return environment(repoId);
          }),
        addSecret: (repoId, { name, value }) =>
          call(() => {
            const secrets = secretsAdmin(repoId);
            if (!value) throw new ApiError(400, "invalid_request", "A secret needs a value.");
            if (secrets.some((s) => s.name === name)) {
              throw new ApiError(409, "secret_exists", `${name} is already here.`);
            }
            this.secrets.set(
              repoId,
              [...secrets, { name, updatedAt: now() }].sort((a, b) => a.name.localeCompare(b.name)),
            );
            return environment(repoId);
          }),
        replaceSecret: (repoId, name) =>
          call(() => {
            const secrets = secretsAdmin(repoId);
            if (!secrets.some((s) => s.name === name)) {
              throw new ApiError(404, "not_found", "There is no such secret.");
            }
            this.secrets.set(
              repoId,
              secrets.map((s) => (s.name === name ? { name, updatedAt: now() } : s)),
            );
            return environment(repoId);
          }),
        removeSecret: (repoId, name) =>
          call(() => {
            const secrets = secretsAdmin(repoId);
            if (!secrets.some((s) => s.name === name)) {
              throw new ApiError(404, "not_found", "There is no such secret.");
            }
            this.secrets.set(
              repoId,
              secrets.filter((s) => s.name !== name),
            );
            return environment(repoId);
          }),
      },
      usage: {
        get: (workspaceId) => call(() => usage(workspaceId)),
        setCap: (workspaceId, capUsd) =>
          call(() => {
            if (world.member(workspaceId).role !== "admin") {
              throw new ApiError(403, "forbidden", "Only an admin of this workspace can do this.");
            }
            const lowest = usage(workspaceId).cap.lowestUsd;
            if (capUsd < lowest) {
              throw new ApiError(400, "cap_too_low", `The cap can't be below $${lowest}.`, {
                lowestUsd: lowest,
              });
            }
            this.caps.set(workspaceId, capUsd);
            return usage(workspaceId);
          }),
      },
      privacy: {
        setShareUsage: (shareUsage) =>
          call(() => {
            this.sharing.set(userId, shareUsage);
            world.meChanged();
            return { shareUsage };
          }),
      },
      account: {
        delete: (confirm) =>
          call(() => {
            const me = world.person(userId);
            if (confirm.toLowerCase() !== me.githubLogin.toLowerCase()) {
              throw new ApiError(400, "confirmation_mismatch", `Type ${me.githubLogin}.`);
            }
            const teams = world.soleAdminOf(userId);
            if (teams.length > 0) {
              throw new ApiError(409, "sole_admin", "Make someone else an admin first.", {
                workspaces: teams,
              });
            }
            world.forget(userId);
            this.prefs.delete(userId);
            this.sharing.delete(userId);
            this.devices.delete(userId);
          }),
      },
    };
  }

  private base(repoId: string): Base {
    return (
      this.bases.get(repoId) ?? {
        status: "none",
        builtAt: null,
        stack: [],
        rebuild: { requestedAt: null, waiting: false },
      }
    );
  }
}
