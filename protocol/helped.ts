/**
 * What anvc did for this repository, counted four ways and never summed.
 *
 * A tool nobody can see working gets uninstalled, so this is the number a
 * person looks at. It is also the number most tempting to inflate, and people
 * distrust tools that score themselves — one team reported measuring zero
 * benefit from transcript search. So each count is named for exactly what it
 * proves, from certain to heuristic, and they are not added into one figure:
 *
 *   shown      a past attempt was put in front of an agent. Certain.
 *   opened     the agent asked for more: a search, or a record's detail. Certain.
 *   avoided    a dead end was shown, and that session did not record a new
 *              abandoned attempt on the same files. A heuristic, and labelled one.
 *   confirmed  the agent or a person marked a record as helpful. Certain, rare.
 */
import { allActivity, type Activity } from "./activity";
import type { Database } from "bun:sqlite";

export interface Helped {
  shown: number;
  opened: number;
  avoided: number;
  confirmed: number;
  /** Sessions in which anvc put at least one record in front of an agent. */
  sessions: number;
}

export function helped(db: Database, repo: string, rows: Activity[] = allActivity(repo)): Helped {
  const shownPairs = new Set<string>();
  const openedIds = new Set<string>();
  let confirmed = 0;
  const sessionsSpoken = new Set<string>();
  const shownIn = new Map<string, Set<string>>();

  for (const row of rows) {
    if (row.kind === "injected" || row.kind === "searched" || row.kind === "recovered") {
      for (const id of row.records ?? []) {
        shownPairs.add(`${row.session}\u0000${id}`);
        (shownIn.get(row.session) ?? shownIn.set(row.session, new Set()).get(row.session)!).add(id);
      }
      if (row.records?.length) sessionsSpoken.add(row.session);
    }
    if (row.kind === "searched" || row.kind === "opened") {
      for (const id of row.records ?? []) if (id) openedIds.add(id);
    }
    if (row.kind === "feedback" && row.verdict === "helped") confirmed++;
  }

  // Avoided: a shown dead end whose session then recorded no new abandoned
  // attempt on any of the same files. The files come from the index.
  const filesOf = db.prepare(`SELECT path FROM files WHERE id = ?`);
  const statusOf = db.prepare(`SELECT status FROM records WHERE id = ?`);
  const abandonedIn = db.prepare(`SELECT id FROM records WHERE run_id = ? AND status = 'abandoned'`);
  let avoided = 0;
  for (const [session, ids] of shownIn) {
    const laterDead = (abandonedIn.all(session) as Array<{ id: string }>).map((r) => r.id);
    const laterFiles = new Set(laterDead.flatMap((id) => (filesOf.all(id) as Array<{ path: string }>).map((r) => r.path)));
    for (const id of ids) {
      if ((statusOf.get(id) as { status: string } | null)?.status !== "abandoned") continue;
      if (laterDead.includes(id)) continue;
      const files = (filesOf.all(id) as Array<{ path: string }>).map((r) => r.path);
      // A dead end with no files cannot be tested this way, and is not counted
      // either way rather than counted as a success.
      if (!files.length) continue;
      if (!files.some((f) => laterFiles.has(f))) avoided++;
    }
  }

  return {
    shown: shownPairs.size,
    opened: openedIds.size,
    avoided,
    confirmed,
    sessions: sessionsSpoken.size,
  };
}
