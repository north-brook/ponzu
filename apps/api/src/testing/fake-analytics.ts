import type { AnalyticsSink, Captured } from "../analytics/analytics.ts";
import type { ServerEvent, ServerEvents } from "../analytics/events.ts";

/** A capture as the sink was handed it, typed by its event. */
export type CapturedEvent<E extends ServerEvent = ServerEvent> = Captured & {
  event: E;
  properties: ServerEvents[E] & Record<string, unknown>;
};

/**
 * Where the test app's analytics go: arrays, exactly as PostHog would be handed them (who, which
 * workspace, which session), for a test to read.
 */
export class MemoryAnalytics implements AnalyticsSink {
  readonly events: Captured[] = [];
  readonly people: {
    distinctId: string;
    set: Record<string, unknown>;
    setOnce: Record<string, unknown>;
  }[] = [];
  readonly groups: { groupType: string; groupKey: string; properties: Record<string, unknown> }[] =
    [];
  readonly exceptions: {
    error: Error;
    distinctId: string | null;
    properties: Record<string, unknown>;
  }[] = [];
  flushes = 0;

  capture(message: Captured): void {
    this.events.push(message);
  }

  identify(
    distinctId: string,
    set: Record<string, unknown>,
    setOnce: Record<string, unknown>,
  ): void {
    this.people.push({ distinctId, set, setOnce });
  }

  group(groupType: string, groupKey: string, properties: Record<string, unknown>): void {
    this.groups.push({ groupType, groupKey, properties });
  }

  exception(error: Error, distinctId: string | null, properties: Record<string, unknown>): void {
    this.exceptions.push({ error, distinctId, properties });
  }

  async flush(): Promise<void> {
    this.flushes++;
  }

  /** Every capture of `event`, oldest first. */
  of<E extends ServerEvent>(event: E): CapturedEvent<E>[] {
    return this.events.filter((e) => e.event === event) as CapturedEvent<E>[];
  }

  /** The names captured, oldest first. */
  names(): string[] {
    return this.events.map((e) => e.event);
  }
}
