import { expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadView } from "../cloud/thread/thread-view.tsx";
import { TipProvider } from "../cloud/ui/tooltip.tsx";
import {
  apiErrors,
  isMaintenance,
  MAINTENANCE_NOTICE,
  MAINTENANCE_QUIET_MS,
  maintenanceNotice,
} from "./maintenance.ts";
import { Banner } from "./notices.tsx";

/*
 * The maintenance switch in the window: the notice over the work while Ponzu is read-only, and
 * the thread's foot while wakes are paused, each in the production design's words.
 */

const maintenance = new ApiError(
  503,
  "maintenance",
  "Ponzu is updating. Try again in a few minutes.",
);

test("the notice is the design's sentence, said over the work", () => {
  expect(MAINTENANCE_NOTICE).toBe(
    "Ponzu is updating. Your canvases are safe; you can look around, and changes come back in a few minutes.",
  );
  const html = renderToStaticMarkup(<Banner>{MAINTENANCE_NOTICE}</Banner>);
  expect(html).toContain('role="status"');
  expect(html).toContain("Ponzu is updating. Your canvases are safe; you can look around");
});

test("only the switch's own error says it, and not again for a minute", () => {
  expect(isMaintenance(maintenance)).toBe(true);
  // A database that didn't answer is a 503 too, and not this.
  const database = new ApiError(503, "database_unavailable", "Ponzu could not reach its database.");
  expect(isMaintenance(database)).toBe(false);
  expect(maintenanceNotice(database, null, 1_000)).toBeNull();

  expect(maintenanceNotice(maintenance, null, 1_000)).toEqual({ say: true, at: 1_000 });
  expect(maintenanceNotice(maintenance, 1_000, 1_000 + MAINTENANCE_QUIET_MS - 1)).toBeNull();
  expect(maintenanceNotice(maintenance, 1_000, 1_000 + MAINTENANCE_QUIET_MS)).toEqual({
    say: true,
    at: 1_000 + MAINTENANCE_QUIET_MS,
  });
});

test("every listener hears each error the host heard, until it lets go", () => {
  const errors = apiErrors();
  const heard: string[] = [];
  const stop = errors.listen((error) => heard.push(error.code));
  errors.heard(maintenance);
  stop();
  errors.heard(maintenance);
  expect(heard).toEqual(["maintenance"]);
});

const handlers = {
  renderDrawing: () => null,
  onOpenComment() {},
  onOpenArtboards() {},
  onOpenPullRequest() {},
  onOpenLink() {},
};

test("wakes paused, the thread's foot says the agent is paused and the message is kept", () => {
  const html = renderToStaticMarkup(
    <TipProvider>
      <ThreadView
        items={[]}
        older="none"
        onLoadOlder={() => {}}
        agent={{ state: "idle", status: null, sandbox: "paused" }}
        meId="usr_1"
        handlers={handlers}
      />
    </TipProvider>,
  );
  expect(html).toContain(
    "The agent is paused while Ponzu updates. Your message is kept and goes through when it&#x27;s back.",
  );
});
