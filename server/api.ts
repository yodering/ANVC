/**
 * Data for the repository view.
 *
 * The one thing a normal forge cannot show: the attempts behind the code,
 * including the ones abandoned along the way. Everything here is derived from
 * git plus refs/anvc, never stored twice.
 */
import type { Database } from "bun:sqlite";
import { gitOrNull } from "../protocol/git";
import { graph, summary, withIndex } from "../protocol/query";
import { structure } from "../protocol/structure";
import { diagram } from "./layout";
import type { CheckpointRecord, Tier } from "../protocol/record";
import { allActivity, repoRoot } from "../protocol/activity";
import { helped } from "../protocol/helped";
import { stats } from "../protocol/stats";

/**
 * Turns as a timeline: what the agent did, in order, with timestamps.
 *
 * This is the view no forge has an equivalent of. GitHub shows the diff a
 * commit produced; this shows the work that produced it — which files were read
 * before anything was written, which commands failed, how long it took, and
 * whether the turn was kept or thrown away.
 */
export interface TurnAction { at: number; kind: string; label: string; full: string }
export interface TurnDetail {
  output?: string;
  narrative?: string;
  ruled_out?: Array<{ approach: string; because: string }>;
  not_investigated?: string[];
  commands?: string[];
}
export interface Turn {
  /** Why it was retired, when it was: no longer shown to agents. */
  retired: string | null;
  id: string;
  ref: string;
  /** Private stays on this machine; shared travels with `git push`. */
  tier: Tier;
  /** The session that produced this turn, so the UI can group by run. */
  run: string;
  /** The commit this turn is anchored to, when it is one. What makes a record
   *  evidence rather than a note — and what the forge link points at. */
  anchorCommit: string | null;
  /**
   * The attempt this one continued from, when the agent linked them.
   *
   * What separates "three approaches were tried from one starting point" from
   * "three unrelated things happened" — and the reason a reader can follow a
   * dead end forward to whatever finally worked.
   */
  parent: string | null;
  /** The earlier version this one replaced. */
  supersedes: string | null;
  /** The later version that replaced this one. */
  replacedBy: string | null;
  /** Abandoned, and nothing has retried or replaced it. */
  openDeadEnd: boolean;
  start: string;
  seconds: number;
  status: string;
  intent: string;
  reads: number;
  writes: number;
  shells: number;
  /** Set when the agent wrote its own record rather than being scraped. */
  authored: boolean;
  why: string | null;
  constraints: string[];
  /** One command that says whether the verdict still holds. */
  recheck: string | null;
  /**
   * The dense half: verbatim output, the prose account, what was ruled out and
   * what nobody checked. Stored on the record and, until this field, never
   * shown anywhere — though it is the part measured to change what a reader does.
   */
  detail: TurnDetail | null;
  filesWritten: string[];
  actions: TurnAction[];
}

function hasDetail(detail: CheckpointRecord["detail"]): boolean {
  if (!detail) return false;
  return Boolean(detail.output?.trim() || detail.narrative?.trim() ||
    detail.ruled_out?.length || detail.not_investigated?.length || detail.commands?.length);
}

export function turns(db: Database, records: Map<string, CheckpointRecord>, limit = 40): Turn[] {
  {
    const rows = db.prepare(`SELECT id, ref, ts, status, intent, intent_source, run_id, anchor_kind, anchor_oid, parent, supersedes, tier, retired
      FROM records WHERE retires IS NULL AND result IS NULL ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Array<{ id: string; ref: string; ts: string; status: string; intent: string;
        intent_source: string; run_id: string; anchor_kind: string; anchor_oid: string;
        parent: string | null; supersedes: string | null; tier: string; retired: string | null }>;
    // Records point back only, so what retried or replaced a row is found by
    // looking at every record, including ones older or newer than the page.
    const links = db.prepare(`SELECT id, parent, supersedes FROM records
      WHERE retires IS NULL AND (parent IS NOT NULL OR supersedes IS NOT NULL)`)
      .all() as Array<{ id: string; parent: string | null; supersedes: string | null }>;
    const followed = new Set(links.flatMap((l) => [l.parent, l.supersedes]));
    const replacedBy = new Map(links.filter((l) => l.supersedes).map((l) => [l.supersedes!, l.id]));

    const out: Turn[] = [];
    for (const row of rows) {
      const record = records.get(row.ref);
      if (!record) continue;
      const actions = record.actions ?? [];
      const first = actions.length ? new Date(actions[0]!.ts).getTime() : new Date(row.ts).getTime();
      const last = actions.length ? new Date(actions.at(-1)!.ts).getTime() : first;

      out.push({
        id: row.id,
        ref: row.ref,
        // From the index, which knows a record with a shared copy is shared
        // even when the version read here is its fuller private companion.
        tier: row.tier === "private" ? "private" : "shared",
        retired: row.retired,
        run: row.run_id,
        // Only a commit anchor is linkable; a blob anchor exists precisely
        // because the work never became a commit.
        anchorCommit: row.anchor_kind === "commit" ? row.anchor_oid : null,
        parent: row.parent ?? null,
        supersedes: row.supersedes ?? null,
        replacedBy: replacedBy.get(row.id) ?? null,
        openDeadEnd: row.status === "abandoned" && !row.retired && !followed.has(row.id),
        start: actions.length ? actions[0]!.ts : row.ts,
        seconds: Math.max(1, Math.round((last - first) / 1000)),
        status: row.status,
        intent: row.intent,
        authored: row.intent_source === "authored",
        why: record.intent.why ?? null,
        constraints: record.intent.constraints ?? [],
        recheck: record.outcome.recheck ?? null,
        detail: hasDetail(record.detail) ? record.detail! : null,
        reads: actions.filter((a) => a.kind === "read").length,
        writes: actions.filter((a) => a.kind === "write").length,
        shells: actions.filter((a) => a.kind === "shell").length,
        filesWritten: record.delta?.files ?? [],
        // `at` is seconds from the start of the turn, which is what a timeline plots.
        actions: actions.map((a) => ({
          at: Math.round((new Date(a.ts).getTime() - first) / 1000),
          kind: a.kind,
          label: (a.path ? a.path.split(/[\\/]/).slice(-2).join("/") : a.command ?? "").slice(0, 80),
          full: a.path ?? a.command ?? "",
        })),
      });
    }
    return out;
  }
}

/**
 * The repository's web home on its forge, or null when it has none.
 *
 * Records name commits and files, and the forge renders those far better than
 * we would — so we link out instead of reimplementing a diff viewer. That is
 * the whole reason this is a layer rather than a competitor.
 */
export function forgeUrl(repo: string): string | null {
  const remote = gitOrNull(repo, ["remote", "get-url", "origin"]);
  if (!remote) return null;
  // Both shapes git accepts: scp-like (git@host:owner/repo) and a real URL.
  const ssh = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/.exec(remote.trim());
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const url = /^https?:\/\/(?:[^@]+@)?([\w.-]+)\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return url ? `https://${url[1]}/${url[2]}` : null;
}

/**
 * Everything the work log shows, from one index build. It is polled every ten
 * seconds, so it reads nothing the page does not draw.
 */
export function repoView(repo: string, limit = 40) {
  return withIndex(repo, (db, records) => {
    return {
      name: repo.split(/[\\/]/).pop(),
      forge: forgeUrl(repo),
      turns: turns(db, records, limit),
      // The repo view is polled, so it skips the staleness pass: that one asks
      // git per record and is the only expensive field in `summary`.
      stats: summary(db),
    };
  });
}

/**
 * The drawn views: boxes and wires with coordinates already resolved.
 *
 * Layout runs here rather than in the browser because ELK is 3.1 MB bundled
 * and about 90 ms to run — absurd to ship, pointless to move. Not part of
 * `repoView`, because that one polls and the shape of a project does not
 * change between two polls.
 */
export async function mapView(repo: string) {
  const g = withIndex(repo, (db) => graph(db, repo));
  // Structure comes from the code, so the map is right on a repository that
  // has recorded nothing yet — which is exactly when it is most needed.
  const code = structure(repo, { tests: false });
  const flow = await diagram(g, code);
  return {
    flow, maps: g.maps,
    files: code.files.length,
    records: g.records.length,
    lines: code.files.reduce((n, f) => n + f.lines, 0),
    unresolved: code.unresolved.length,
  };
}

/** What anvc did here: shown, opened, avoided, confirmed. */
export const helpedView = (repo: string) =>
  withIndex(repo, (db) => helped(db, repo, allActivity(repoRoot(repo) ?? repo)));

/** Everything the Stats page counts. */
export const statsView = (repo: string) => withIndex(repo, (db, records) => stats(db, repoRoot(repo) ?? repo, turns(db, records, Number.MAX_SAFE_INTEGER)));
