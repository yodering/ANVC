/**
 * The evidence a record can carry without the agent writing it.
 *
 * An agent writes the goal and the reason, and then, mostly, nothing else:
 * measured on this repository, 2 of 46 records carried the output of what
 * failed. But the raw log already holds every command the session ran and
 * what each printed. So when a record arrives without them, the commands run
 * since the session's previous record, the last one that failed with its
 * output, and the files edited are attached from there. The agent's words are
 * never replaced; only what it left empty is filled.
 *
 * The project's settings still decide where each part goes: the full output
 * and the steps stay on this machine under the team preset.
 */
import type { CaptureEvent } from "./ingest";
import { captureRows, headTail, inRepo, lastDays } from "./rawlog";
import { errorLine } from "./search";
import { runnable } from "./recheck";
import { canonical, MAX_DETAIL_BYTES, MAX_DETAIL_ITEMS, MAX_ERROR_BYTES, MAX_RECORD_BYTES, type CheckpointRecord } from "./record";

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The repository files these rows edited, each once, in the order first edited. */
export function editedFiles(rows: CaptureEvent[], root: string): string[] {
  const toRepo = inRepo(root);
  return [...new Set(rows.filter((r) => r.tool && EDITS.has(r.tool))
    .map((r) => toRepo(r.path)).filter((p): p is string => p !== null))];
}

/** This session's rows in a repository's raw log, after a time, oldest first. */
export function sessionRows(root: string, session: string, since: string | null): CaptureEvent[] {
  return captureRows(root, undefined, lastDays(2), [JSON.stringify(session)])
    .filter((row) => row.session_id === session && (!since || row.ts > since))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** What was attached, for the agent's reply. */
export interface Filled { commands: number; failure: string | null; files: number; recheck: string | null }

/**
 * Fills a record's empty evidence from the session's raw log. Returns what
 * was added; the record is changed in place.
 */
export function fillEvidence(record: CheckpointRecord, rows: CaptureEvent[], root: string): Filled {
  const filled: Filled = { commands: 0, failure: null, files: 0, recheck: null };
  const commands = rows.filter((r) => r.tool === "Bash" && r.command).map((r) => r.command!);
  // A failure on the way to work that was kept is not why it was kept, and
  // shown as the record's error it would read as the opposite.
  const failed = record.outcome.status === "abandoned"
    ? rows.filter((r) => r.tool === "Bash" && r.ok === false && r.command).at(-1) : undefined;
  const edited = editedFiles(rows, root);
  let output = false, errors = false;

  const detail = { ...(record.detail ?? {}) };
  if (!detail.commands?.length && commands.length) {
    detail.commands = commands.slice(-MAX_DETAIL_ITEMS);
    filled.commands = detail.commands.length;
  }
  if (!detail.output && failed?.output) {
    detail.output = `$ ${failed.command}\n${failed.output}`.slice(0, MAX_DETAIL_BYTES);
    output = true;
  }
  if (Object.keys(detail).length) record.detail = detail;

  // The failing command's last line is what a search for the error finds.
  if (!record.outcome.errors?.length && failed) {
    const last = errorLine(failed.output ?? "");
    let error = `${failed.command}${last ? `: ${last}` : " failed"}`.slice(0, MAX_ERROR_BYTES);
    // The cap is in bytes, and a character can take four.
    while (Buffer.byteLength(error, "utf8") > MAX_ERROR_BYTES) error = error.slice(0, -1);
    record.outcome.errors = [error];
    errors = true;
  }
  // A dead end with no check is one the hook can only describe, and describing
  // it, however carefully, doesn't stop an agent following it once it goes
  // stale; running its check does. When the agent named none, the
  // last test command that failed in this session is the check that settled
  // it, if it's one the hook may run. The reply says so, so the agent can
  // correct it.
  if (record.outcome.status === "abandoned" && !record.outcome.recheck) {
    const test = rows.filter((r) => r.tool === "Bash" && r.ok === false && r.command && runnable(r.command)).at(-1);
    if (test) { record.outcome.recheck = test.command!.trim(); filled.recheck = record.outcome.recheck; }
  }
  if (!record.delta?.files?.length && edited.length) {
    record.delta = { ...(record.delta ?? {}), files: edited.slice(0, 500) };
    filled.files = edited.length;
  }
  fit(record, filled, output);
  if ((output && record.detail?.output) || errors) filled.failure = failed!.command!;
  return filled;
}

/**
 * Shortens what fillEvidence attached until the record fits the 64 KiB cap,
 * as ingest's fit() does for a scraped turn. A long session can attach 40
 * commands of any length, 500 paths and 24 KiB of output, and a record over
 * the cap is refused whole, the agent's own words with it. The commands go
 * first, the latest kept; then the output, halved by shape; then the files,
 * the first edited kept. What the agent wrote is never shortened.
 */
function fit(record: CheckpointRecord, filled: Filled, output: boolean): void {
  const over = () => Buffer.byteLength(canonical(record), "utf8") > MAX_RECORD_BYTES;
  const detail = record.detail;
  while (filled.commands && detail?.commands?.length && over()) {
    detail.commands = detail.commands.slice(Math.ceil(detail.commands.length / 2));
    filled.commands = detail.commands.length;
    record.truncated = true;
  }
  // The output was cut to 24K characters, and multibyte text that long is
  // over the 24 KiB the field allows.
  while (output && detail?.output && (over() || Buffer.byteLength(detail.output, "utf8") > MAX_DETAIL_BYTES)) {
    const half = Math.floor(detail.output.length / 2);
    record.truncated = true;
    if (half < 400) { delete detail.output; break; }
    detail.output = headTail(detail.output, half);
  }
  while (filled.files && record.delta?.files?.length && over()) {
    record.delta.files = record.delta.files.slice(0, Math.floor(record.delta.files.length / 2));
    filled.files = record.delta.files.length;
    record.truncated = true;
  }
  if (detail?.commands?.length === 0) delete detail.commands;
  if (record.delta?.files?.length === 0) delete record.delta.files;
}
