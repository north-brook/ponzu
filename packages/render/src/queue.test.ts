import { expect, test } from "bun:test";
import { JobQueue } from "./queue.ts";
import { RenderError } from "./stages.ts";

/** A job that runs until told to finish. */
function job() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { finish, run: () => done };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("runs up to the limit at once and the rest in the order they came", async () => {
  const queue = new JobQueue(2, 1_000);
  const started: number[] = [];
  const jobs = [job(), job(), job(), job()];
  const runs = jobs.map((j, i) =>
    queue.run(() => {
      started.push(i);
      return j.run();
    }),
  );
  await tick();
  expect(started).toEqual([0, 1]);
  jobs[1]!.finish();
  await tick();
  expect(started).toEqual([0, 1, 2]);
  jobs[0]!.finish();
  await tick();
  expect(started).toEqual([0, 1, 2, 3]);
  jobs[2]!.finish();
  jobs[3]!.finish();
  await Promise.all(runs);
});

test("a job that fails gives its slot up", async () => {
  const queue = new JobQueue(1, 1_000);
  const failed = await queue.run(() => Promise.reject(new Error("boom"))).catch((e) => e);
  expect(failed.message).toBe("boom");
  expect(await queue.run(async () => "next")).toBe("next");
});

test("a job that waits too long fails as busy, and doesn't take a slot with it", async () => {
  const queue = new JobQueue(1, 20);
  const first = job();
  const running = queue.run(first.run);
  let ran = false;
  const late = await queue
    .run(async () => {
      ran = true;
    })
    .catch((e) => e);
  expect(late).toBeInstanceOf(RenderError);
  expect(late).toMatchObject({ failure: "host_busy", stage: "queue" });
  expect(ran).toBe(false);
  first.finish();
  await running;
  // The slot the first job held is free again: the one that gave up never claimed it.
  expect(await queue.run(async () => "after")).toBe("after");
  const again = job();
  const held = queue.run(again.run);
  const waits = queue.run(async () => "queued");
  again.finish();
  await held;
  expect(await waits).toBe("queued");
});
