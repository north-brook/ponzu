import {
  type ComponentType,
  createElement,
  type Key,
  type ReactElement,
  useMemo,
  useRef,
} from "react";
import { useUnchanged } from "./sidebar-data.ts";

/*
 * For the window's big pieces (the sidebar, the chrome, the dialogs), which it draws again
 * whenever any of its own state changes: a live update to one canvas's row, the thread moving on.
 * Their props are made fresh each time, so React would draw them again even when nothing they
 * show has changed. With their functions made stable here and their data shared where it is
 * equal (`useUnchanged`), their element is the same object until something it shows changes,
 * and React leaves the piece alone.
 */

type Handlers = Record<string, (...args: any[]) => any>;

/**
 * The same functions on every render, each calling the latest of the `handlers` passed in: for
 * what a control does when it is used, never for anything drawn from. The keys are the first
 * render's.
 */
export function useHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const stable = useRef<T | null>(null);
  if (!stable.current) {
    stable.current = Object.fromEntries(
      Object.keys(handlers).map((key) => [
        key,
        (...args: unknown[]) => latest.current[key]!(...args),
      ]),
    ) as T;
  }
  return stable.current;
}

/**
 * `<type {...props} />`, the same element until a prop's value changes: each function among
 * the props is a stable one that calls the latest given (so only handlers, never a function
 * the piece draws from), and data equal to the last render's is the last render's
 * (`keepUnchanged`). A function that comes or goes (null where there was one) still counts.
 */
export function useKeptElement<P extends object>(
  type: ComponentType<P>,
  props: P,
  key?: Key,
): ReactElement {
  const latest = useRef(props as Record<string, unknown>);
  latest.current = props as Record<string, unknown>;
  const calls = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const given: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (typeof value !== "function") {
      given[name] = value;
      continue;
    }
    let call = calls.current.get(name);
    if (!call) {
      call = (...args: unknown[]) =>
        (latest.current[name] as (...args: unknown[]) => unknown)(...args);
      calls.current.set(name, call);
    }
    given[name] = call;
  }
  const kept = useUnchanged(given);
  return useMemo(
    () => createElement(type, { ...(kept as P), ...(key === undefined ? {} : { key }) }),
    [type, kept, key],
  );
}
