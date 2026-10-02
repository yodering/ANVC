/**
 * What ANVC did in the background for one project, and what it cost, for the
 * Stats page.
 *
 * People couldn't tell whether ANVC did anything: what it puts in front of an
 * agent goes into the agent's context, which nobody reads. Every count here
 * comes from a line ANVC wrote when it acted (the activity log, the hooks'
 * metrics log, the raw log), and each is named for exactly what that line
 * shows. "Avoided" is the one estimate, as protocol/helped.ts says.
 */
import type { Database } from "bun:sqlite";
import { allActivity } from "./activity";
import { helped } from "./helped";
import { captureRows, jsonl, lastDays, metricsRoot, readJsonl, isRepo } from "./rawlog";
import { commandKey } from "./repeats";

export interface Stats {
  /** The first thing ANVC logged here. */
  since: string | null;
  /** Compactions after which a session's own work was put back. */
  recovered: number;
  /** Past attempts put in front of an agent, each counted once a session. */
  shown: number;
  /** The sessions they were shown in. */
  sessions: number;
  /** Commands stopped because they failed in an earlier session. */
  stopped: number;
  /** Of those, the ones the session never ran again. */
  notRunAgain: number;
  /** Failed commands answered with an earlier attempt that hit the same error. */
  matched: number;
  /** Times a rule set's text came before the agent wrote what it covers. */
  rules: number;
  /** Times the agent asked ANVC itself: a search, or a record's detail. */
  asked: number;
  /** The work log's rows: those the agent recorded with a reason, and those saved from the raw log without one. */
  recorded: number;
  saved: number;
  /** Goals and writing rules updated from the sessions, and the model's tokens. */
  absorbed: { updates: number; tokens: number };
  /** What ANVC's hooks put into agents' context, in characters. */
  added: number;
  /** Shown dead ends the session didn't hit again on the same files: an estimate. */
  avoided: number;
  /** Records the agent or the person marked as helpful. */
  confirmed: number;
}

type Metric = { ts?: string; repo?: string; session?: string; event?: string; injected?: boolean; records?: string[]; chars?: number; stopped?: string };

/** `attempts` are the work log's rows, so its counts and these agree. */
export function stats(db: Database, repo: string, attempts: Array<{ authored: boolean }> = []): Stats {
  const activity = allActivity(repo);
  const here = isRepo(repo);
  const metrics = jsonl(metricsRoot()).flatMap((file) => readJsonl<Metric>(file)).filter((m) => here(m.repo) && m.ts);
  const stops = metrics.filter((m) => m.stopped && m.session);
  const h = helped(db, repo, activity);
  const absorbed = activity.filter((a) => a.kind === "absorbed");
  const first = [activity[0]?.ts, metrics.map((m) => m.ts!).sort()[0]].filter(Boolean).sort()[0] ?? null;
  return {
    since: first,
    recovered: activity.filter((a) => a.kind === "recovered").length,
    shown: h.shown,
    sessions: h.sessions,
    stopped: stops.length,
    notRunAgain: stops.filter((m) => !ranAgain(repo, m)).length,
    matched: metrics.filter((m) => m.event === "PostToolUseFailure" && m.injected && m.records?.length).length,
    rules: metrics.filter((m) => m.event === "PreToolUse" && m.injected && !m.stopped && !m.records?.length).length,
    asked: activity.filter((a) => a.kind === "searched" || a.kind === "opened").length,
    recorded: attempts.filter((a) => a.authored).length,
    saved: attempts.filter((a) => !a.authored).length,
    absorbed: { updates: absorbed.length, tokens: absorbed.reduce((n, a) => n + (a.tokens ?? 0), 0) },
    added: metrics.reduce((n, m) => n + (m.injected ? m.chars ?? 0 : 0), 0),
    avoided: h.avoided,
    confirmed: h.confirmed,
  };
}

/**
 * Whether the session ran the stopped command again later. A row for the
 * stopped attempt itself, if the agent's hooks logged one, says ANVC's reason
 * and doesn't count.
 */
function ranAgain(repo: string, stop: Metric): boolean {
  return captureRows(repo, undefined, lastDays(30), [JSON.stringify(stop.session)])
    .some((r) => r.session_id === stop.session && r.ts > stop.ts! && r.command && commandKey(r.command)?.key === stop.stopped
      && !(r.output ?? "").includes("failed in an earlier session here"));
}
