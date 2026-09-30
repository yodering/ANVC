/**
 * Saves the work an agent finished without recording it.
 *
 * The goal and the reason in a record can only come from the agent, so the
 * agent is asked to write them. When it doesn't, the raw log still saw the
 * prompt, the commands, the files and what failed. Left there, that is lost
 * to the work log and to search; saved as a record, it stays, and the work
 * log marks it as one the agent gave no reason for.
 *
 * Runs when a session ends (Claude Code, Codex and Cursor all send
 * SessionEnd), and when one starts, for sessions whose end never arrived: a
 * closed terminal, a crash. Private, like every record built from the
 * raw log: nobody reviewed it.
 *
 * Turns before the agent's last record in a session are left alone. An agent
 * that records at the end of a piece of work covers the prompts that led to
 * it, and saving those turns again would mark work as unexplained that was
 * explained.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logActivity } from "./activity";
import { ingest } from "./ingest";
import { captureRows, lastDays, readJson, repoKey, stateRoot } from "./rawlog";
import { readRecords } from "./record";

/** A session counts as over once its log has been quiet this long. */
const QUIET_MS = 30 * 60_000;
/** How far back a session start looks for sessions nobody closed. */
const DAYS = 3;

const doneFile = (repo: string) => join(stateRoot(), `autosaved-${repoKey(repo)}.json`);

/**
 * Saves what the agent left unrecorded.
 *
 * With `session`, that session only, because it just ended. Without, every
 * other session in the last three days whose log has gone quiet. A session
 * is looked at again when its log has grown since, or when a turn in it
 * couldn't be stored.
 */
export function autosave(repo: string, opts: { session?: string; except?: string } = {}): string[] {
  const now = Date.now();
  const rows = captureRows(repo, undefined, lastDays(DAYS, now)).filter((row) => row.anvc_capture === 0 && row.session_id);

  // A first run has none.
  const done = readJson<Record<string, string>>(doneFile(repo), {});

  const ready = [...Map.groupBy(rows, (row) => row.session_id!)]
    .map(([session, list]) => ({ session, list, last: list.reduce((m, e) => (e.ts > m ? e.ts : m), "") }))
    .filter(({ session, last }) => {
      if (done[session] && done[session]! >= last) return false;
      if (opts.session) return session === opts.session;
      return session !== opts.except && now - Date.parse(last) >= QUIET_MS;
    });
  if (!ready.length) return [];

  // The agent's own records, by session: turns before the last one are its.
  const lastRecorded = new Map<string, string>();
  for (const [, r] of readRecords(repo)) {
    if (typeof r.intent.goal !== "string") continue;
    const at = lastRecorded.get(r.session.run_id);
    if (!at || r.ts > at) lastRecorded.set(r.session.run_id, r.ts);
  }

  const saved: string[] = [];
  for (const { session, list, last } of ready) {
    const after = lastRecorded.get(session);
    const { ids, failed } = ingest(repo, after ? list.filter((e) => e.ts > after) : list, { fresh: true });
    if (ids.length) logActivity({ kind: "autosaved", repo, session, records: ids });
    saved.push(...ids);
    if (!failed.length) { done[session] = last; continue; }
    // Left unmarked, so the turns that weren't stored are tried again next
    // time; ingest skips the ones that were. Each failure reads "<id>: <why>".
    logActivity({
      kind: "autosaved", repo, session, outcome: "failed",
      records: failed.map((f) => f.slice(0, f.indexOf(": "))), titles: failed.map((f) => f.slice(f.indexOf(": ") + 2)),
    });
  }

  // Sessions older than the look-back can't come back; keep the file small.
  const cutoff = new Date(now - (DAYS + 1) * 86_400_000).toISOString();
  for (const [session, ts] of Object.entries(done)) if (ts < cutoff) delete done[session];
  try {
    mkdirSync(stateRoot(), { recursive: true });
    writeFileSync(doneFile(repo), JSON.stringify(done));
  } catch { /* looked at again next time; ingest skips what it already wrote */ }
  return saved;
}
