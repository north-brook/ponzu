import { describe, expect, test } from "bun:test";
import { type Op, OpError } from "./doc.ts";
import { sampleDoc } from "./fixtures/ops.ts";
import { random } from "./fixtures/random.ts";
import { randomOp } from "./fixtures/random-ops.ts";
import { Sequencer } from "./fixtures/sequencer.ts";
import { Replica } from "./replica.ts";
import type { Actor } from "./types.ts";

/**
 * Several replicas of one design, each making random ops, over a network that delays, loses
 * and repeats things. Time is simulated and every choice comes from one seed, so a run that
 * fails fails the same way again.
 */

interface Network {
  replicas: number;
  /** Ops each replica tries to make. */
  ops: number;
  /** The chance a request is lost on its way to the API, and again on its way back. */
  loss: number;
  /** The chance a replica never hears that the head moved. */
  deaf: number;
  /** Whether the API lets go of old ops now and then, so a replica behind them gets "gone". */
  forgets: boolean;
}

/** A clock that jumps from one scheduled task to the next. */
class Sim {
  private tasks: { at: number; order: number; run: () => void }[] = [];
  private now = 0;
  private scheduled = 0;

  after = (run: () => void, ms: number): (() => void) => {
    const task = { at: this.now + ms, order: this.scheduled++, run };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((t) => t !== task);
    };
  };

  /** Run until nothing is scheduled, calling `each` after every task. */
  async run(each: () => void): Promise<void> {
    while (this.tasks.length) {
      const next = this.tasks.reduce((a, b) =>
        b.at < a.at || (b.at === a.at && b.order < a.order) ? b : a,
      );
      this.tasks = this.tasks.filter((t) => t !== next);
      this.now = next.at;
      next.run();
      // Every promise the task settled runs its course before the next task.
      await new Promise<void>((resolve) => setImmediate(resolve));
      each();
    }
  }
}

/** How often each thing came up, added up over every run, so a test can check they all did. */
const seen = {
  committed: 0,
  changed: 0,
  rejected: 0,
  conflicts: 0,
  lost: 0,
  wholeFetches: 0,
  unfit: 0,
};

async function simulate(seed: number, network: Network): Promise<void> {
  const r = random(seed);
  const sim = new Sim();
  const api = new Sequencer(sampleDoc());
  let loss = network.loss;

  const peers = Array.from({ length: network.replicas }, (_, i) => {
    const actor: Actor = { kind: i % 2 ? "agent" : "user", id: `actor_${i}`, name: `Actor ${i}` };
    /** Each op as it was made, by the id it was posted with. */
    const made = new Map<string, string>();
    /** Committed ops this replica heard, as `[actor, op]` JSON. Its own optimistic ops aren't in here. */
    const heard: string[] = [];
    let applying = false;

    const request = <T>(serve: () => T): Promise<T> =>
      new Promise((resolve, reject) => {
        const lostOut = r.chance(loss);
        const lostBack = r.chance(loss);
        if (lostOut || lostBack) seen.lost++;
        sim.after(() => {
          if (lostOut) return reject(new Error("The request was lost."));
          const before = api.seq;
          const answer = serve();
          if (api.seq > before) announce();
          sim.after(
            () => (lostBack ? reject(new Error("The response was lost.")) : resolve(answer)),
            5 + r.int(200),
          );
        }, 5 + r.int(200));
      });

    let ids = 0;
    const replica = new Replica({
      transport: {
        commit: (ops) => request(() => api.commit(ops, actor)),
        fetchOps: (after) => request(() => api.opsAfter(after)),
        fetchDoc: () => {
          seen.wholeFetches++;
          return request(() => api.snapshot());
        },
      },
      schedule: sim.after,
      actor,
      ...api.snapshot(),
      newId: () => `r${i}-${++ids}`,
    });
    replica.onOp((op, by) => {
      if (!applying) heard.push(JSON.stringify([by.id, op]));
    });
    replica.onDrop((dropped) => {
      if (dropped.cause === "conflict") seen.conflicts++;
    });

    let left = network.ops;
    let minted = 0;
    const act = () => {
      if (left-- <= 0) return;
      const op = randomOp(r, replica.doc, () => `${i}x${++minted}`);
      const before = JSON.stringify(replica.doc);
      applying = true;
      try {
        replica.apply(op);
        made.set(replica.pending.at(-1)!.id, JSON.stringify(op));
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        // An op that doesn't fit leaves no trace.
        expect(JSON.stringify(replica.doc)).toBe(before);
        seen.unfit++;
      } finally {
        applying = false;
      }
      sim.after(act, r.int(400));
    };
    sim.after(act, r.int(400));
    return { actor, replica, made, heard };
  });

  /** The head row moved. Each replica hears of it late, twice, or not at all. */
  function announce(): void {
    const seq = api.seq;
    for (const peer of peers) {
      if (r.chance(network.deaf)) continue;
      for (let times = r.chance(0.2) ? 2 : 1; times > 0; times--)
        sim.after(() => peer.replica.notify(seq), r.int(600));
    }
  }

  if (network.forgets) {
    const forget = (times: number) => {
      api.forget(Math.max(0, api.seq - r.int(4)));
      if (times > 1) sim.after(() => forget(times - 1), 1000 + r.int(3000));
    };
    sim.after(() => forget(6), 1000 + r.int(3000));
  }

  /** With nothing pending, a replica shows exactly what the API had at its seq. */
  const check = () => {
    for (const { replica } of peers) {
      if (replica.pending.length) continue;
      const mine = JSON.stringify(replica.doc);
      if (mine !== api.history[replica.seq])
        throw new Error(
          `Seed ${seed}: a replica at seq ${replica.seq} differs from the API there.`,
        );
    }
  };

  await sim.run(check);
  // Quiet. The network mends, and each replica hears where the head is.
  loss = 0;
  for (const { replica } of peers) replica.notify(api.seq);
  await sim.run(check);

  const final = JSON.stringify(api.doc);
  for (const { replica } of peers) {
    expect(replica.pending).toEqual([]);
    expect(replica.seq).toBe(api.seq);
    expect(JSON.stringify(replica.doc)).toBe(final);
    expect(replica.offline).toBe(false);
  }
  // What the generator slipped in was sanitized, stamped or rejected by the API.
  expect(final).not.toMatch(/steal\(\)|Forged|expression\(|javascript:|not an id|<script|iframe/);

  for (const peer of peers) {
    const theirs = api.log.filter((c) => c.actor.id !== peer.actor.id);
    const own = api.log.filter((c) => c.actor.id === peer.actor.id);
    const key = (c: { actor: Actor; op: Op }) => JSON.stringify([c.actor.id, c.op]);
    const heardOwn = peer.heard.filter((h) => h.startsWith(`["${peer.actor.id}"`));
    const heardTheirs = peer.heard.filter((h) => !h.startsWith(`["${peer.actor.id}"`));

    // Everyone else's ops: each heard once. Unless whole fetches skipped some, and then never twice.
    if (network.forgets) expect(within(heardTheirs, theirs.map(key))).toBe(true);
    else expect(heardTheirs.sort()).toEqual(theirs.map(key).sort());

    // Its own: heard again when committed only as far as they could be news, and always
    // when the API changed them.
    const changed = own.filter((c) => JSON.stringify(c.op) !== peer.made.get(c.id));
    expect(within(heardOwn, own.map(key))).toBe(true);
    if (!network.forgets) expect(within(changed.map(key), heardOwn)).toBe(true);
    seen.changed += changed.length;
  }
  seen.committed += api.log.length;
  seen.rejected += peers.reduce((n, p) => n + p.made.size, 0) - api.log.length;
}

/** Whether every item of `part` is in `whole`, counting repeats. */
function within(part: string[], whole: string[]): boolean {
  const left = new Map<string, number>();
  for (const item of whole) left.set(item, (left.get(item) ?? 0) + 1);
  for (const item of part) {
    const n = left.get(item) ?? 0;
    if (n === 0) return false;
    left.set(item, n - 1);
  }
  return true;
}

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

describe("replicas converge on the API's document", () => {
  test.each(SEEDS)("on a network that only delays: seed %i", async (seed) => {
    await simulate(seed, { replicas: 3, ops: 50, loss: 0, deaf: 0, forgets: false });
  });

  test.each(SEEDS)(
    "when requests and notifications are lost and repeated: seed %i",
    async (seed) => {
      await simulate(1000 + seed, { replicas: 4, ops: 50, loss: 0.2, deaf: 0.4, forgets: false });
    },
  );

  test.each(SEEDS)("when the API lets go of old ops as well: seed %i", async (seed) => {
    await simulate(2000 + seed, { replicas: 4, ops: 50, loss: 0.2, deaf: 0.6, forgets: true });
  });

  test("and the runs above went through everything a replica has to handle", () => {
    expect(seen.committed).toBeGreaterThan(2000);
    expect(seen.changed).toBeGreaterThan(200);
    expect(seen.rejected).toBeGreaterThan(100);
    expect(seen.conflicts).toBeGreaterThan(20);
    expect(seen.lost).toBeGreaterThan(500);
    expect(seen.wholeFetches).toBeGreaterThan(10);
    expect(seen.unfit).toBeGreaterThan(20);
  });
});
