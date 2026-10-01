/**
 * Everything anvc did, in one private log.
 *
 * The most common complaint about agent memory is that nobody can see it
 * working: what it injected, whether the agent looked, whether any of it
 * mattered. anvc logged its injections to a file nothing read and did not log
 * the agent's own lookups at all, so it could not answer "did this do anything
 * for me" even for itself.
 *
 * Every part writes here: the injection hook when it shows a record, the MCP
 * server when the agent searches, opens detail or records an attempt, the stop
 * hook when it asks for a record. The session receipt, `anvc activity` and the
 * helped stats all read from here.
 *
 * Private tier: under ~/.anvc, never pushed. It names record ids and titles,
 * never a prompt.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gitOrNull } from "./git";
import { isRepo, jsonl, metricsRoot, readJsonl } from "./rawlog";

type ActivityKind =
  | "injected"   // records put in front of an agent, unasked
  | "searched"   // the agent asked anvc a question
  | "opened"     // the agent asked for a record's detail or its revisions
  | "recorded"   // the agent wrote a record
  | "feedback"   // the agent or person judged a record
  | "retired"    // the agent retired a record, or proposed to (outcome says which)
  | "nudged"     // the stop hook asked for a record
  | "recovered"  // after compaction, this session's own history was restored
  | "autosaved"; // the agent recorded nothing, so records were built from the raw log

export interface Activity {
  ts: string;
  kind: ActivityKind;
  repo: string;
  session: string;
  agent_id?: string;
  /** Record ids involved, in the order shown or returned. */
  records?: string[];
  /** Their titles, so a log line reads without a lookup. */
  titles?: string[];
  /** What was asked, for a search. */
  query?: string;
  hits?: number;
  /** For `recorded`: which tier, and kept or abandoned. */
  tier?: string;
  outcome?: string;
  /** For `feedback`: the verdict. */
  verdict?: string;
  /** The hook event or MCP tool that produced this row. */
  via?: string;
}

const dir = () => process.env.ANVC_ACTIVITY_DIR ?? join(homedir(), ".anvc", "activity");

/**
 * The repository's own root, the same from every worktree.
 *
 * `--show-toplevel` names the worktree, so a session in a worktree logged its
 * events under a different repository than the main checkout and its history
 * was invisible there. Records never had this problem, since git refs are shared
 * across worktrees; only the files keyed by path did. The common git directory
 * is the one thing every worktree agrees on.
 */
export function repoRoot(cwd: string): string | null {
  const common = gitOrNull(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common?.endsWith("/.git")) return dirname(common);
  return gitOrNull(cwd, ["rev-parse", "--show-toplevel"]) || null;
}

/**
 * Appends a row, stamped now, to today's file in `dir`. Never throws: a log
 * that can break a session is worse than no log.
 */
export function appendDaily(dir: string, row: object): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
  } catch { /* measurement is not worth a broken session */ }
}

export const logActivity = (row: Omit<Activity, "ts">): void => appendDaily(dir(), row);

export function readActivity(filter: { repo?: string; session?: string; since?: string; kinds?: ActivityKind[] } = {}): Activity[] {
  const since = filter.since?.slice(0, 10);
  const here = filter.repo ? isRepo(filter.repo) : null;
  const out: Activity[] = [];
  for (const file of jsonl(dir())) {
    // Files are named by day, so whole days before `since` are skipped unread.
    if (since && basename(file).slice(0, 10) < since) continue;
    for (const row of readJsonl<Activity>(file)) {
      if (here && !here(row.repo)) continue;
      if (filter.session && row.session !== filter.session) continue;
      if (filter.since && row.ts <= filter.since) continue;
      if (filter.kinds && !filter.kinds.includes(row.kind)) continue;
      out.push(row);
    }
  }
  return out;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * One or two lines saying what anvc did, or null when it did nothing.
 *
 * Silent on a quiet turn: a receipt that appears every time says nothing, and
 * people turn off tools that talk without cause. It speaks when a record was
 * shown, searched for, opened or written.
 *
 * `statusOf` says how records ended, and is asked only about records whose
 * titles would read the same.
 */
export function receipt(rows: Activity[], statusOf?: (ids: string[]) => Map<string, string>): string | null {
  const shown = new Set<string>(), opened = new Set<string>();
  const titles = new Map<string, string>();
  let searches = 0;
  const recorded: Activity[] = [];
  let retired = 0, proposed = 0;
  for (const row of rows) {
    (row.records ?? []).forEach((id, i) => { const t = row.titles?.[i]; if (id && t) titles.set(id, t); });
    if (row.kind === "injected" || row.kind === "recovered") row.records?.forEach((id) => shown.add(id));
    if (row.kind === "searched") { searches++; row.records?.forEach((id) => shown.add(id)); }
    if (row.kind === "opened") row.records?.forEach((id) => id && opened.add(id));
    if (row.kind === "recorded") recorded.push(row);
    if (row.kind === "retired") row.outcome === "retired" ? retired++ : proposed++;
  }
  const parts: string[] = [];
  if (shown.size) parts.push(`showed ${plural(shown.size, "past attempt")}`);
  if (searches) parts.push(`the agent searched ${searches === 1 ? "once" : `${searches} times`}`);
  if (opened.size) parts.push(`opened ${plural(opened.size, "record")} in full`);
  // Counted, with one named when it's the only one: a session that recorded
  // fifty results printed fifty of them in one line.
  const results = recorded.filter((r) => r.outcome === "result");
  if (results.length === 1) parts.push(`recorded a result: ${results[0]!.titles?.[0] ?? ""}`.trim());
  else if (results.length) parts.push(`recorded ${results.length} results`);
  const attempts = recorded.filter((r) => r.outcome !== "result");
  if (attempts.length === 1) parts.push(`recorded ${attempts[0]!.outcome ?? "an"} attempt (${attempts[0]!.tier ?? "shared"})`);
  else if (attempts.length) parts.push(`recorded ${attempts.length} attempts (${[...Map.groupBy(attempts, (r) => r.outcome ?? "other")].map(([o, rs]) => `${rs.length} ${o}`).join(", ")})`);
  if (retired) parts.push(`retired ${plural(retired, "record")}`);
  // The one line here that asks the person for something.
  if (proposed) parts.push(`the agent wants to retire ${plural(proposed, "record")}: anvc retire list`);
  if (!parts.length) return null;

  // Name what was opened first: an agent asking for more is the strongest sign
  // it mattered. Then whatever was shown. Records that read the same are named
  // once, with how many there are and how each ended: two attempts at one goal
  // printed twice looked like one line said twice.
  const byName = new Map<string, string[]>();
  for (const id of [...opened, ...shown]) {
    const name = titles.get(id)?.slice(0, 60);
    if (name && !byName.get(name)?.includes(id)) byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  const named = [...byName].slice(0, 2);
  const alike = named.flatMap(([, ids]) => (ids.length > 1 ? ids : []));
  let ended = new Map<string, string>();
  if (alike.length && statusOf) { try { ended = statusOf(alike); } catch { /* the count still stands */ } }
  const say = ([name, ids]: [string, string[]]) => {
    if (ids.length === 1) return `"${name}"`;
    const how = ids.map((id) => ended.get(id)).filter((s): s is string => !!s);
    if (how.length < ids.length) return `"${name}" (${ids.length} records)`;
    if (new Set(how).size === 1) return `"${name}" (${ids.length} records, ${ids.length === 2 ? "both" : "all"} ${how[0]})`;
    return `"${name}" (${ids.length} records: ${how.join(", ")})`;
  };
  const detail = named.length ? `\n      ${named.map(say).join(", ")}` : "";
  return `ANVC  ${parts.join(" · ")}${detail}`;
}

/**
 * Injections logged before this log existed.
 *
 * The injection hook has written ~/.anvc/metrics since well before today, one
 * row per invocation with the ids it showed. Those records really were put in
 * front of an agent, so they count as shown — read as they are, not re-dated
 * or invented. Only rows that showed something become activity.
 */
function earlierInjections(repo: string): Activity[] {
  type Row = { ts?: string; repo?: string; session?: string; injected?: boolean; records?: string[]; event?: string; agent_id?: string };
  const here = isRepo(repo);
  return jsonl(metricsRoot()).flatMap((file) => readJsonl<Row>(file))
    .filter((r) => here(r.repo) && r.injected && r.records?.length && r.ts)
    .map((r): Activity => ({ ts: r.ts!, kind: "injected", repo, session: r.session ?? "unknown", records: r.records, via: r.event, ...(r.agent_id ? { agent_id: r.agent_id } : {}) }));
}

/**
 * Everything anvc did here: the activity log, plus earlier injections not
 * already in it. A row in both — every injection since the activity log began
 * is written to both files — is counted once.
 */
export function allActivity(repo: string): Activity[] {
  const now = readActivity({ repo });
  const since = now.find((r) => r.kind === "injected")?.ts;
  const before = earlierInjections(repo).filter((r) => !since || r.ts < since);
  return [...before, ...now].sort((a, b) => a.ts.localeCompare(b.ts));
}
