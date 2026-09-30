/**
 * Why a line is there: line, to the commit that last changed it, to the
 * attempts behind that commit, abandoned ones included.
 *
 * git blame says who and when. The commit message says what, when it says
 * anything. Neither says what was tried first and dropped, which is the part
 * that stops someone rewriting the line back the way it was.
 */
import type { Database } from "bun:sqlite";
import { gitOrNull, OID } from "./git";
import { attemptsBehind, why, type Hit } from "./query";

interface LineWhy {
  path: string;
  line: number;
  /** The commit that last changed the line, or null while it is uncommitted. */
  commit: { oid: string; subject: string; date: string } | null;
  attempts: Hit[];
}

/** `src/api.ts:42` as a path and a line; null when there is no line. */
export function splitLine(target: string): { path: string; line: number } | null {
  const m = /^(.+):(\d+)$/.exec(target);
  return m ? { path: m[1]!, line: Number(m[2]) } : null;
}

export function whyLine(db: Database, repo: string, path: string, line: number): LineWhy {
  const blame = gitOrNull(repo, ["blame", "-L", `${line},${line}`, "--porcelain", "--", path]) ?? "";
  const oid = blame.split(/\s/, 1)[0] ?? "";
  // All zeros: the line is not committed yet, so the work behind it is the
  // work recorded on the file lately.
  if (!OID.test(oid) || /^0+$/.test(oid)) {
    return { path, line, commit: null, attempts: why(db, path, 5) };
  }
  const subject = /^summary (.*)$/m.exec(blame)?.[1] ?? "";
  const when = Number(/^committer-time (\d+)$/m.exec(blame)?.[1] ?? 0) * 1000;
  const parents = (gitOrNull(repo, ["rev-list", "--parents", "-n", "1", oid]) ?? "").split(/\s+/).slice(1);
  const parentTime = parents[0]
    ? Number(gitOrNull(repo, ["show", "-s", "--format=%ct", parents[0]]) ?? "0") * 1000
    : when - 86_400_000;
  const attempts = attemptsBehind(db, path, [oid, ...parents],
    new Date(parentTime).toISOString(), new Date(when + 2 * 3_600_000).toISOString());
  return { path, line, commit: { oid, subject, date: new Date(when).toISOString() }, attempts };
}
