#!/usr/bin/env bun
/*
 * One line of main's performance history from a run's results: `bun history.ts results.json`
 * prints it, and the workflow appends it to history.jsonl on the perf-history branch. Imports
 * nothing installed, so it runs before (or without) `bun install`.
 */
import { readFileSync } from "node:fs";
import { historyEntry, type Results } from "./report.ts";

const results = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Results;
console.log(JSON.stringify(historyEntry(results)));
