import AsyncStorage from "@react-native-async-storage/async-storage";
import { Store } from "./store";

/**
 * What Search shows before anything's typed: the last few searches, and the
 * designs opened lately (the page each was on). Kept on this phone only.
 */
export interface Opened {
  mac: string;
  key: string;
  /** The page it was on, by id. */
  page?: string;
  at: number;
}

export interface Lately {
  searches: string[];
  opened: Opened[];
}

const KEY = "ponzu.lately";
/** How many of each it keeps. */
export const KEEP = { searches: 6, opened: 3 } as const;

export const lately = new Store<Lately>({ searches: [], opened: [] });
AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Lately>;
    lately.set((now) => ({
      searches: merge(now.searches, saved.searches ?? [], KEEP.searches),
      opened: [...now.opened, ...(saved.opened ?? [])].slice(0, KEEP.opened),
    }));
  })
  .catch(() => {});

function save() {
  AsyncStorage.setItem(KEY, JSON.stringify(lately.get())).catch(() => {});
}

/** `first` ahead of `rest`, each once (ignoring case), at most `keep`. */
function merge(first: string[], rest: string[], keep: number): string[] {
  const out: string[] = [];
  for (const s of [...first, ...rest]) {
    if (!out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, keep);
}

/** A search the person settled on: newest first, each once. */
export function rememberSearch(all: Lately, query: string): Lately {
  const q = query.trim();
  if (!q) return all;
  return { ...all, searches: merge([q], all.searches, KEEP.searches) };
}

/** A design the person opened, or turned the page in: newest first, each design once. */
export function rememberOpened(all: Lately, o: Opened): Lately {
  const rest = all.opened.filter((x) => !(x.mac === o.mac && x.key === o.key));
  return { ...all, opened: [o, ...rest].slice(0, KEEP.opened) };
}

export function noteSearch(query: string) {
  const next = rememberSearch(lately.get(), query);
  if (next === lately.get()) return;
  lately.set(next);
  save();
}

export function noteOpened(o: Opened) {
  lately.set(rememberOpened(lately.get(), o));
  save();
}
