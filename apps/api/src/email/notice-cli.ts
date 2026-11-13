import { join } from "node:path";
import {
  type NoticeDeps,
  type NoticePlan,
  type NoticeReport,
  type NoticeRequest,
  noticeProps,
  planNotice,
  renderNotice,
  requestProblem,
  sendNotice,
  sendRefusal,
} from "./notice.ts";
import { NOTICES } from "./notices/index.ts";

/*
 * What apps/api/scripts/notice.ts does, apart from reading the environment, so it can be tested
 * on fakes:
 *
 *   notice.ts --notice <id> --dry-run|--send [--user <id> …] [--sooner]
 *             [--case <id> --reason-file <path> [--workspace <id>]] [--out <dir>]
 *
 * `--dry-run` reads and writes nothing in the database: it prints the counts and renders the
 * email to `<dir>/<notice>.html` and `.txt` to read. `--send` sends. Neither prints an address,
 * a name or the reason; only counts and the ids of people whose notice needs a look.
 */

export const NOTICE_USAGE =
  "usage: DATABASE_URL=… PONZU_ENVIRONMENT=… [RESEND_API_KEY=…] bun apps/api/scripts/notice.ts " +
  "--notice <id> --dry-run|--send [--user <id> …] [--sooner] " +
  "[--case <id> --reason-file <path> [--workspace <id>]] [--out <dir>]";

export interface NoticeArgs {
  noticeId: string;
  send: boolean;
  users: string[] | null;
  caseId: string | null;
  workspaceId: string | null;
  reasonFile: string | null;
  sooner: boolean;
  out: string | null;
}

/** The arguments, or why they are not understood. */
export function parseNoticeArgs(argv: readonly string[]): NoticeArgs | string {
  const args: NoticeArgs = {
    noticeId: "",
    send: false,
    users: null,
    caseId: null,
    workspaceId: null,
    reasonFile: null,
    sooner: false,
    out: null,
  };
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
      return next;
    };
    try {
      if (flag === "--notice") args.noticeId = value();
      else if (flag === "--dry-run") dryRun = true;
      else if (flag === "--send") args.send = true;
      else if (flag === "--user") args.users = [...(args.users ?? []), value()];
      else if (flag === "--case") args.caseId = value();
      else if (flag === "--workspace") args.workspaceId = value();
      else if (flag === "--reason-file") args.reasonFile = value();
      else if (flag === "--sooner") args.sooner = true;
      else if (flag === "--out") args.out = value();
      else return `Not understood: ${flag}.`;
    } catch (error) {
      return (error as Error).message;
    }
  }
  if (!args.noticeId) return "Say which notice with --notice <id>.";
  if (dryRun === args.send) return "Say exactly one of --dry-run and --send.";
  return args;
}

export interface NoticeIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  print(line: string): void;
  /** Where a dry run writes its sample when `--out` is not given. */
  tmpdir: string;
}

/** Runs the script; answers its exit code: 0 done, 1 something needs the founder, 2 refused. */
export async function runNotice(deps: NoticeDeps, args: NoticeArgs, io: NoticeIo): Promise<number> {
  const notice = NOTICES.get(args.noticeId);
  if (!notice) {
    io.print(`No notice ${args.noticeId}. There are: ${[...NOTICES.keys()].join(", ")}.`);
    return 2;
  }
  let reason: string | null = null;
  if (args.reasonFile) {
    // The reason is the founder's own words: kept as written, but for the file's last newline.
    reason = (await io.readFile(args.reasonFile)).replace(/\r?\n$/, "");
  }
  const request: NoticeRequest = {
    notice,
    users: args.users,
    caseId: args.caseId,
    workspaceId: args.workspaceId,
    reason,
    sooner: args.sooner,
  };
  const problem = requestProblem(request);
  if (problem) {
    io.print(`Refused: ${problem}`);
    return 2;
  }

  if (!args.send) return dryRun(deps, request, args, io);

  const refusal = sendRefusal(request, {
    now: new Date(deps.clock.now()),
    environment: deps.config.build.environment,
    mailEnabled: deps.mail.enabled,
  });
  if (refusal) {
    io.print(`Refused, nothing sent or written: ${refusal}`);
    return 2;
  }
  const plan = await planNotice(deps, request);
  if (plan.outside.length > 0) {
    io.print(
      `Refused, nothing sent or written: ${plan.outside.length} of the people --user names ` +
        `are not ones ${notice.id} is for: ${plan.outside.join(", ")}.`,
    );
    return 2;
  }
  const report = await sendNotice(deps, request);
  for (const line of describeReport(report)) io.print(line);
  return report.stale.length > 0 || report.stoppedEarly ? 1 : 0;
}

async function dryRun(
  deps: NoticeDeps,
  request: NoticeRequest,
  args: NoticeArgs,
  io: NoticeIo,
): Promise<number> {
  const plan = await planNotice(deps, request);
  io.print(`Dry run: nothing sent or written.`);
  for (const line of describePlan(plan)) io.print(line);
  const refusal = sendRefusal(request, {
    now: new Date(deps.clock.now()),
    environment: deps.config.build.environment,
    mailEnabled: deps.mail.enabled,
  });
  io.print(refusal ? `--send would be refused now: ${refusal}` : "--send would send it now.");
  if (request.notice.kind !== "suspension" && request.notice.effective === null) {
    io.print("No sample: it has no day it takes effect yet.");
    return 0;
  }
  const rendered = await renderNotice(await noticeProps(deps, request));
  const base = join(args.out ?? io.tmpdir, `ponzu-notice-${plan.recordId.replace("/", "-")}`);
  await io.writeFile(`${base}.html`, rendered.html);
  await io.writeFile(`${base}.txt`, `Subject: ${rendered.subject}\n\n${rendered.text}`);
  io.print(`The email, to read: ${base}.html and ${base}.txt`);
  return 0;
}

/** The plan as lines: counts, and the ids of people whose notice needs a look. Never an address. */
export function describePlan(plan: NoticePlan): string[] {
  const lines = [
    `Notice ${plan.recordId}: ${plan.recipients.length} people.`,
    `  without an address now: ${plan.withoutAddress}`,
    `  already sent: ${plan.done.sent}; refused: ${plan.done.refused}; ` +
      `no address: ${plan.done.no_address}; held: ${plan.done.held}`,
    `  to send: ${plan.fresh}; to send again with the same key (pending, under 24 hours): ${plan.retry}`,
    `  pending over 24 hours, never sent again: ${plan.stale.length}`,
  ];
  if (plan.stale.length > 0) lines.push(`    ${plan.stale.join(", ")}`);
  if (plan.outside.length > 0) {
    lines.push(`  named by --user but not ones it is for: ${plan.outside.join(", ")}`);
  }
  return lines;
}

export function describeReport(report: NoticeReport): string[] {
  const { outcomes } = report;
  const lines = [
    `Notice ${report.recordId}: sent ${outcomes.sent}; refused ${outcomes.refused}; ` +
      `no address ${outcomes.no_address}; held ${outcomes.held}; already done ${report.alreadyDone}.`,
  ];
  if (report.stale.length > 0) {
    lines.push(
      `Pending over 24 hours, never sent again (check each at Resend by its key): ${report.stale.join(", ")}`,
    );
  }
  if (report.stoppedEarly) {
    lines.push(`Stopped early: ${report.stoppedEarly} Run it again within 24 hours.`);
  }
  return lines;
}
